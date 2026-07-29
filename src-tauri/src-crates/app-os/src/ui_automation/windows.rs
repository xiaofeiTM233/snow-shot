use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::mem;

use atree::Arena;
use atree::Token;
use rtree_rs::{RTree, Rect};
use uiautomation::UIAutomation;
use uiautomation::UIElement;
use uiautomation::UITreeWalker;
use uiautomation::core::UICacheRequest;
use uiautomation::types::Point;
use uiautomation::types::TreeScope;
use uiautomation::types::UIProperty;

use snow_shot_app_shared::ElementRect;
use snow_shot_app_utils::monitor_info::MonitorList;
use std::sync::{Arc, Mutex};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
use windows::Win32::UI::WindowsAndMessaging::{
	EnumChildWindows, IsWindowVisible, GetWindowRect, WNDENUMPROC,
};
use xcap::ImplWindow;
use xcap::Window;

use super::ElementLevel;
use super::UIAutomationError;

/// 子元素查找模式：决定使用哪种 UIA 视图，以及是否包含原生子窗口
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElementFindMode {
	/// 标准：UIA 内容视图（现有行为，元素最少）
	Standard,
	/// 精细：UIA 控件视图（含容器/分组等结构，推荐）
	Fine,
	/// 最深：UIA 原始视图（含全部节点，最精细但可能包含无意义的装饰节点）
	Deepest,
}

impl Default for ElementFindMode {
	fn default() -> Self {
		ElementFindMode::Fine
	}
}

enum ElementChildrenNextSiblingCacheItem {
    Element(UIElement, ElementLevel),
    /**
     * 叶子节点
     */
    Leaf,
    /**
     * 没有下一个兄弟节点
     */
    NoNext,
}

pub struct UIElements {
    automation: Option<Arc<UIAutomationWrapper>>,
    automation_walker: Option<UITreeWalker>,
    root_element: Option<UIElement>,
    cache_request: Option<UICacheRequest>,
    element_cache: RTree<2, i32, ElementLevel>,
    element_level_map: HashMap<ElementLevel, (UIElement, Token)>,
    element_rect_tree: Arena<uiautomation::types::Rect>,
    element_children_next_sibling_cache: HashMap<ElementLevel, ElementChildrenNextSiblingCacheItem>,
    window_rect_map: HashMap<ElementLevel, uiautomation::types::Rect>,
    window_index_level_map: HashMap<i32, ElementLevel>,
    window_app_name_map: HashMap<i32, String>,
    blacklisted_window_indices: HashSet<i32>,
    /// 子元素查找模式
    element_mode: ElementFindMode,
    /// 是否枚举原生子窗口（HWND）
    include_child_windows: bool,
    /// 窗口索引 -> 顶层窗口 HWND 映射，用于缓存失效检测
    window_index_hwnd_map: HashMap<i32, HWND>,
}

unsafe impl Send for UIElements {}
unsafe impl Sync for UIElements {}

struct UIElementWrapper {
    element: UIElement,
}

unsafe impl Send for UIElementWrapper {}
unsafe impl Sync for UIElementWrapper {}

struct UIAutomationWrapper {
    automation: UIAutomation,
}

unsafe impl Send for UIAutomationWrapper {}
unsafe impl Sync for UIAutomationWrapper {}

impl UIElements {
    pub fn new() -> Self {
        Self {
            automation: None,
            automation_walker: None,
            root_element: None,
            cache_request: None,
            element_rect_tree: Arena::new(),
            element_cache: RTree::new(),
            element_level_map: HashMap::new(),
            element_children_next_sibling_cache: HashMap::new(),
            window_rect_map: HashMap::new(),
            window_index_level_map: HashMap::new(),
            window_app_name_map: HashMap::new(),
            blacklisted_window_indices: HashSet::new(),
            element_mode: ElementFindMode::Fine,
            include_child_windows: true,
            window_index_hwnd_map: HashMap::new(),
        }
    }

    pub fn init(&mut self) -> Result<(), UIAutomationError> {
        if self.automation.is_some() {
            return Ok(());
        }

        let automation = UIAutomation::new()?;
        let automation_walker = automation.get_content_view_walker()?;

        // 创建缓存请求，预先缓存常用属性
        let cache_request = automation.create_cache_request()?;

        // 缓存边界矩形属性（最重要的性能优化点）
        cache_request.add_property(UIProperty::BoundingRectangle)?;

        // 缓存其他常用属性
        cache_request.add_property(UIProperty::ControlType)?;
        cache_request.add_property(UIProperty::IsOffscreen)?;

        // 设置缓存范围：缓存元素本身
        cache_request.set_tree_scope(TreeScope::Element)?;

        self.automation = Some(Arc::new(UIAutomationWrapper { automation }));
        self.automation_walker = Some(automation_walker);
        self.cache_request = Some(cache_request);

        Ok(())
    }

    pub fn set_mode(&mut self, mode: ElementFindMode, include_child_windows: bool) {
        self.element_mode = mode;
        self.include_child_windows = include_child_windows;
    }

    /// EnumChildWindows 的回调：通过 LPARAM 传回的指针把子窗口 HWND 收集进 Mutex。
    /// 必须是不捕获任何数据的裸函数指针，生命周期由调用方（children Arc）保证。
    unsafe extern "system" fn enum_child_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let mutex = &*(lparam.0 as *const Mutex<Vec<HWND>>);
        if let Ok(mut list) = mutex.lock() {
            list.push(hwnd);
        }
        TRUE
    }

    fn collect_immediate_child_windows(parent: HWND) -> Vec<HWND> {
        let children = Arc::new(Mutex::new(Vec::<HWND>::new()));
        // 通过 LPARAM 把 Mutex 指针传给回调，回调只依赖 lparam，不捕获 Arc，
        // 因此调用结束后 children 仍由我们独占，可安全 try_unwrap 取出结果。
        let lparam = Arc::as_ptr(&children) as LPARAM;
        let _ = unsafe { EnumChildWindows(Some(parent), WNDENUMPROC(Some(Self::enum_child_proc)), lparam) };
        Arc::try_unwrap(children)
            .unwrap_or_else(|_| Mutex::new(Vec::new()))
            .into_inner()
            .unwrap_or_default()
    }

    fn is_window_selectable(hwnd: HWND) -> bool {
        unsafe { IsWindowVisible(hwnd) }.as_bool()
    }

    /**
     * 递归枚举原生子窗口，并把它们作为可选区域插入缓存。
     * 原生 HWND 层级与 UIA 树互补，能找回被 ContentView 过滤掉的子区域（如浏览器/Office/Electron 的子窗口）。
     */
    fn enumerate_child_windows(
        &mut self,
        parent_hwnd: HWND,
        parent_level: ElementLevel,
        mut parent_token: Token,
        automation: &Arc<UIAutomationWrapper>,
    ) {
        if !self.include_child_windows {
            return;
        }

        let children = Self::collect_immediate_child_windows(parent_hwnd);
        let mut child_level = parent_level;
        child_level.next_level();

        for hwnd in children {
            if !Self::is_window_selectable(hwnd) {
                continue;
            }

            let element = match automation
                .automation
                .element_from_handle(uiautomation::types::Handle::from(hwnd.0 as isize))
            {
                Ok(element) => element,
                Err(_) => continue,
            };

            let rect = match element.get_bounding_rectangle() {
                Ok(rect) => Self::normalize_rect(rect),
                Err(_) => continue,
            };

            // 仅保留比窗口区域更小的子窗口，避免把整个客户区再框一遍
            let window_level = self
                .window_index_level_map
                .get(&parent_level.window_index)
                .cloned()
                .unwrap_or(parent_level);
            let parent_rect = match self.window_rect_map.get(&window_level).cloned() {
                Some(rect) => rect,
                None => continue,
            };

            let is_same_as_parent = rect.get_left() >= parent_rect.get_left() - 1
                && rect.get_top() >= parent_rect.get_top() - 1
                && rect.get_right() <= parent_rect.get_right() + 1
                && rect.get_bottom() <= parent_rect.get_bottom() + 1;

            if is_same_as_parent {
                continue;
            }

            let (_, token) =
                self.insert_element_cache(&mut parent_token, element, rect, child_level);

            // 继续递归更深的子窗口
            self.enumerate_child_windows(hwnd, child_level, token, automation);

            child_level.next_element();
        }
    }

    pub fn convert_element_rect_to_rtree_rect(rect: uiautomation::types::Rect) -> Rect<2, i32> {
        Rect::new(
            [rect.get_left(), rect.get_top()],
            [rect.get_right(), rect.get_bottom()],
        )
    }

    fn normalize_rect(rect: uiautomation::types::Rect) -> uiautomation::types::Rect {
        // 当前矩形的数据不可信，做个纠正
        let mut rect_left = rect.get_left();
        let mut rect_top = rect.get_top();
        let mut rect_right = rect.get_right();
        let mut rect_bottom = rect.get_bottom();

        if rect_left > rect_right {
            mem::swap(&mut rect_left, &mut rect_right);
        }

        if rect_top > rect_bottom {
            mem::swap(&mut rect_top, &mut rect_bottom);
        }

        uiautomation::types::Rect::new(rect_left, rect_top, rect_right, rect_bottom)
    }

    fn beyond_rect(
        rect: uiautomation::types::Rect,
        parent_rect: uiautomation::types::Rect,
    ) -> bool {
        if rect.get_left() < parent_rect.get_left() {
            return true;
        }

        if rect.get_right() > parent_rect.get_right() {
            return true;
        }

        if rect.get_top() < parent_rect.get_top() {
            return true;
        }

        if rect.get_bottom() > parent_rect.get_bottom() {
            return true;
        }

        false
    }

    pub fn clip_rect(
        rect: uiautomation::types::Rect,
        parent_rect: uiautomation::types::Rect,
    ) -> uiautomation::types::Rect {
        uiautomation::types::Rect::new(
            rect.get_left().max(parent_rect.get_left()),
            rect.get_top().max(parent_rect.get_top()),
            rect.get_right().min(parent_rect.get_right()),
            rect.get_bottom().min(parent_rect.get_bottom()),
        )
    }

    /**
     * 初始化窗口元素缓存
     */
    pub fn init_cache(&mut self) -> Result<(), UIAutomationError> {
        self.root_element.replace(
            self.automation
                .as_ref()
                .unwrap()
                .automation
                .get_root_element()?,
        );

        let root_element = self.root_element.as_ref().unwrap();

        self.element_rect_tree = Arena::new();
        self.element_cache = RTree::new();
        self.element_level_map.clear();
        self.element_children_next_sibling_cache.clear();
        self.window_rect_map.clear();
        self.window_index_level_map.clear();
        self.window_app_name_map.clear();
        self.blacklisted_window_indices.clear();

        // 桌面的窗口索引应该是最高，因为其优先级最低
        let mut current_level = ElementLevel::root();
        let monitors_bounding_box = MonitorList::all(true).get_monitors_bounding_box();
        let root_element_rect = uiautomation::types::Rect::new(
            monitors_bounding_box.min_x,
            monitors_bounding_box.min_y,
            monitors_bounding_box.max_x,
            monitors_bounding_box.max_y,
        );

        let mut root_tree_token = self.element_rect_tree.new_node(root_element_rect);
        let (_, mut parent_tree_token) = self.insert_element_cache(
            &mut root_tree_token,
            root_element.clone(),
            root_element_rect,
            current_level,
        );

        // 遍历所有窗口
        let windows = Window::all()
            .unwrap_or_default()
            .into_iter()
            .map(|window| window.hwnd().unwrap() as usize)
            .collect::<Vec<usize>>();

        let automation = self.automation.clone();
        let children_list = windows
            .iter()
            .filter_map(|window_hwnd| {
                let window = ImplWindow::new(HWND(*window_hwnd as *mut c_void));

                if window.is_minimized().unwrap_or(true) {
                    return None;
                }

                match window.title() {
                    Ok(title) => {
                        if title.eq("Shell Handwriting Canvas") || title.eq("Snow Shot - Draw") {
                            return None;
                        }

                        title
                    }
                    Err(_) => return None,
                };

                let window_hwnd = match window.hwnd() {
                    Ok(hwnd) => hwnd,
                    Err(_) => return None,
                };

                let window_info = match window.get_window_info() {
                    Ok(window_info) => window_info,
                    Err(_) => return None,
                };

                let element_rect = uiautomation::types::Rect::new(
                    window_info.rcClient.left,
                    window_info.rcClient.top,
                    window_info.rcClient.right,
                    window_info.rcClient.bottom,
                );

                if let Ok(element) =
                    automation.as_ref().unwrap().automation.element_from_handle(
                        uiautomation::types::Handle::from(window_hwnd as isize),
                    )
                {
                    let app_name = window.app_name().unwrap_or_default();
                    Some((
                        UIElementWrapper { element },
                        element_rect,
                        app_name,
                        HWND(window_hwnd),
                    ))
                } else {
                    None
                }
            })
            .collect::<Vec<(UIElementWrapper, uiautomation::types::Rect, String, HWND)>>();

        // 窗口层级
        current_level.window_index = 0;
        current_level.next_level();

        for current_child in children_list {
            current_level.window_index += 1;
            current_level.next_element();

            let (element_wrapper, current_child_rect, app_name, window_hwnd) = current_child;
            let app_name = &app_name;

            let (current_child_rect, window_token) = self.insert_element_cache(
                &mut parent_tree_token,
                element_wrapper.element.clone(),
                current_child_rect,
                current_level,
            );

            self.window_rect_map
                .insert(current_level.clone(), current_child_rect);
            self.window_index_level_map
                .insert(current_level.window_index, current_level.clone());
            self.window_app_name_map
                .insert(current_level.window_index, app_name.clone());
            self.window_index_hwnd_map
                .insert(current_level.window_index, window_hwnd);

            // 枚举该窗口的原生子窗口，补充 UIA 视图之外的可选区域
            self.enumerate_child_windows(
                window_hwnd,
                current_level,
                window_token,
                automation.as_ref().unwrap(),
            );
        }

        Ok(())
    }

    /**
     * 设置子元素查找黑名单
     * 黑名单中的窗口标题对应的窗口不会被遍历子元素，需完全匹配
     */
    pub fn set_blacklist(&mut self, blacklist: &[String]) {
        self.blacklisted_window_indices.clear();
        for (window_index, app_name) in &self.window_app_name_map {
            let app_name_lower = app_name.to_lowercase();
            for item in blacklist {
                if app_name_lower.contains(&item.to_lowercase()) {
                    self.blacklisted_window_indices.insert(*window_index);
                    break;
                }
            }
        }
    }

    pub fn get_element_from_point(
        &self,
        mouse_x: i32,
        mouse_y: i32,
    ) -> Result<Option<ElementRect>, UIAutomationError> {
        let automation = match self.automation.as_ref() {
            Some(automation) => automation,
            None => return Ok(None),
        };

        // 使用带缓存的版本获取元素
        let element = if let Some(cache_request) = &self.cache_request {
            automation
                .automation
                .element_from_point_build_cache(Point::new(mouse_x, mouse_y), cache_request)?
        } else {
            automation
                .automation
                .element_from_point(Point::new(mouse_x, mouse_y))?
        };

        // 优先使用缓存的边界矩形
        let rect = if self.cache_request.is_some() {
            // 缓存模式下只能调用缓存方法，不能fallback到实时查询
            element.get_cached_bounding_rectangle().unwrap_or_default() // 如果缓存失败，返回默认值
        } else {
            element.get_bounding_rectangle()?
        };

        Ok(Some(ElementRect {
            min_x: rect.get_left(),
            min_y: rect.get_top(),
            max_x: rect.get_right(),
            max_y: rect.get_bottom(),
        }))
    }

    pub fn insert_element_cache(
        &mut self,
        parent_tree_token: &mut Token,
        element: UIElement,
        element_rect: uiautomation::types::Rect,
        element_level: ElementLevel,
    ) -> (uiautomation::types::Rect, Token) {
        let element_rect = uiautomation::types::Rect::new(
            element_rect.get_left(),
            element_rect.get_top(),
            element_rect.get_right(),
            element_rect.get_bottom(),
        );

        let mut element_rect = Self::normalize_rect(element_rect);

        let window_rect = self
            .window_rect_map
            .get(
                &self
                    .window_index_level_map
                    .get(&element_level.window_index)
                    .unwrap_or(&element_level),
            )
            .unwrap_or(&element_rect)
            .clone();

        if Self::beyond_rect(element_rect, window_rect) {
            element_rect = Self::clip_rect(element_rect, window_rect);
        }

        self.element_cache.insert(
            Self::convert_element_rect_to_rtree_rect(element_rect),
            element_level,
        );

        let current_node = self.element_rect_tree.new_node(element_rect);
        parent_tree_token
            .append_node(&mut self.element_rect_tree, current_node)
            .unwrap();
        self.element_level_map
            .insert(element_level, (element, current_node));

        (element_rect, current_node)
    }

    fn get_element_from_cache(
        &self,
        mouse_x: i32,
        mouse_y: i32,
    ) -> Option<(UIElement, ElementLevel, uiautomation::types::Rect, Token)> {
        let element_rect = self
            .element_cache
            .search(Rect::new_point([mouse_x, mouse_y]));

        // 收集所有包含该点的候选区域
        let mut candidates: Vec<(ElementLevel, rtree_rs::Rect<2, i32>)> = Vec::new();
        for rect in element_rect {
            candidates.push((rect.data.clone(), rect.rect));
        }

        if candidates.is_empty() {
            return None;
        }

        let point = (mouse_x, mouse_y);
        // 优先级：面积更小（更精细）> 层级更深 > 离鼠标点更近
        let best = candidates
            .iter()
            .max_by(|a, b| {
                Self::rect_area(&b.1)
                    .cmp(&Self::rect_area(&a.1))
                    .then_with(|| a.0.cmp(&b.0))
                    .then_with(|| {
                        Self::rect_center_distance(&a.1, point)
                            .cmp(&Self::rect_center_distance(&b.1, point))
                            .reverse()
                    })
            })
            .unwrap();

        let max_level = best.0.clone();
        let element_rtree_rect = best.1;

        let element_rtree_rect = uiautomation::types::Rect::new(
            element_rtree_rect.min[0],
            element_rtree_rect.min[1],
            element_rtree_rect.max[0],
            element_rtree_rect.max[1],
        );

        match self.element_level_map.get(&max_level) {
            Some((element, token)) => {
                Some((element.clone(), max_level, element_rtree_rect, *token))
            }
            None => None,
        }
    }

    fn rect_area(rect: &rtree_rs::Rect<2, i32>) -> i32 {
        let w = rect.max[0] - rect.min[0];
        let h = rect.max[1] - rect.min[1];
        w.max(0) * h.max(0)
    }

    fn rect_center_distance(rect: &rtree_rs::Rect<2, i32>, point: (i32, i32)) -> i32 {
        let cx = (rect.min[0] + rect.max[0]) / 2;
        let cy = (rect.min[1] + rect.max[1]) / 2;
        let dx = cx - point.0;
        let dy = cy - point.1;
        dx * dx + dy * dy
    }

    // fn skip_invalid_window(
    //     &self,
    //     automation_walker: &UITreeWalker,
    //     current_element: &mut uiautomation::Result<UIElement>,
    //     parent_level: &ElementLevel,
    // ) {
    //     // 跳过 Snow Shot 窗口
    //     if parent_level.is_root() {
    //         if let Ok(element) = current_element.as_ref() {
    //             if let Ok(name) = element.get_name() {
    //                 if name == "Snow Shot - Draw" {
    //                     *current_element = automation_walker.get_next_sibling(element);
    //                     return;
    //                 }
    //             }

    //             unsafe {
    //                 if let Ok(handle) = element.get_native_window_handle() {
    //                     let window_hwnd: HWND = handle.into();
    //                     if !IsWindow(Some(window_hwnd)).as_bool()
    //                         || !IsWindowVisible(window_hwnd).as_bool()
    //                         || IsIconic(window_hwnd).as_bool()
    //                     {
    //                         *current_element = automation_walker.get_next_sibling(element);
    //                         return;
    //                     }
    //                 }
    //             }
    //         }
    //     }
    // }

    /**
     * 获取所有可选区域
     */
    pub fn get_element_from_point_walker(
        &mut self,
        mouse_x: i32,
        mouse_y: i32,
    ) -> Result<Vec<ElementRect>, UIAutomationError> {
        // 按当前模式选择 UIA 视图（content/control/raw）
        let automation = self.automation.clone().unwrap();
        let automation_walker = match self.element_mode {
            ElementFindMode::Standard => automation.automation.get_content_view_walker(),
            ElementFindMode::Fine => automation.automation.get_control_view_walker(),
            ElementFindMode::Deepest => automation.automation.get_raw_view_walker(),
        };
        let automation_walker = match automation_walker {
            Ok(walker) => walker,
            Err(_) => self.automation_walker.clone().unwrap(),
        };

        let (parent_element, mut parent_level, parent_rect, mut parent_tree_token) =
            match self.get_element_from_cache(mouse_x, mouse_y) {
                Some(element) => element,
                None => (
                    self.root_element.clone().unwrap(),
                    ElementLevel::root(),
                    uiautomation::types::Rect::new(0, 0, i32::MAX, i32::MAX),
                    self.element_rect_tree
                        .new_node(uiautomation::types::Rect::new(0, 0, i32::MAX, i32::MAX)),
                ),
            };

        // 缓存失效检测：目标窗口位置发生变化则通知上层重建
        if let Some(hwnd) = self.window_index_hwnd_map.get(&parent_level.window_index) {
            let mut current = RECT::default();
            if unsafe { GetWindowRect(*hwnd, &mut current) }.is_ok() {
                let window_level = self
                    .window_index_level_map
                    .get(&parent_level.window_index)
                    .cloned()
                    .unwrap_or(parent_level);
                if let Some(stored) = self.window_rect_map.get(&window_level).cloned() {
                    if current.left != stored.get_left()
                        || current.top != stored.get_top()
                        || current.right != stored.get_right()
                        || current.bottom != stored.get_bottom()
                    {
                        return Err(UIAutomationError::CacheStale);
                    }
                }
            }
        }

        // 检查该窗口是否在黑名单中，如果是则不遍历子元素
        if self
            .blacklisted_window_indices
            .contains(&parent_level.window_index)
        {
            return Err(UIAutomationError::Blacklisted);
        }

        // 父元素必然命中了 mouse position，所以直接取第一个元素
        let mut current_level = ElementLevel::root();

        let mut queue = Option::<UIElement>::None;

        let mut try_get_first_child = false;
        // let mut cache_level = Option::<ElementLevel>::None;
        match self.element_children_next_sibling_cache.get(&parent_level) {
            Some(element) => match element {
                ElementChildrenNextSiblingCacheItem::Element(element, level) => {
                    queue = Some(element.clone());
                    current_level = level.clone();
                }
                // 叶子节点说明直接命中了，不需要重新获取
                ElementChildrenNextSiblingCacheItem::Leaf => {}
                // 没有下一个节点说明遍历结束了
                ElementChildrenNextSiblingCacheItem::NoNext => {}
            },
            None => {
                try_get_first_child = true;
            }
        };

        if try_get_first_child {
            // 没有命中缓存，说明是第一次获取
            // 使用带缓存的版本获取第一个子元素
            let first_child = if let Some(cache_request) = &self.cache_request {
                automation_walker.get_first_child_build_cache(&parent_element, cache_request)
            } else {
                automation_walker.get_first_child(&parent_element)
            };

            match first_child {
                Ok(element) => {
                    queue = Some(element.clone());
                    current_level = parent_level.clone();
                    current_level.next_level();

                    self.element_children_next_sibling_cache.insert(
                        parent_level,
                        ElementChildrenNextSiblingCacheItem::Element(element, current_level),
                    );
                }
                Err(_) => {
                    self.element_children_next_sibling_cache
                        .insert(parent_level, ElementChildrenNextSiblingCacheItem::Leaf);
                }
            }
        }

        let mut current_element_rect = parent_rect;
        let mut current_element_token = parent_tree_token;
        let mut result_token = current_element_token;
        let mut result_rect = current_element_rect;

        while let Some(current_element) = queue.take() {
            queue = None;

            // 优先使用缓存的属性
            let is_offscreen = if self.cache_request.is_some() {
                current_element.is_cached_offscreen().unwrap_or(true)
            } else {
                current_element.is_offscreen().unwrap_or(true)
            };

            if !is_offscreen {
                current_element_rect = if self.cache_request.is_some() {
                    match current_element.get_cached_bounding_rectangle() {
                        Ok(rect) => rect,
                        Err(_) => continue,
                    }
                } else {
                    match current_element.get_bounding_rectangle() {
                        Ok(rect) => rect,
                        Err(_) => continue,
                    }
                };

                let current_element_left = current_element_rect.get_left();
                let current_element_right = current_element_rect.get_right();
                let current_element_top = current_element_rect.get_top();
                let current_element_bottom = current_element_rect.get_bottom();

                if !(current_element_left == 0
                    && current_element_right == 0
                    && current_element_top == 0
                    && current_element_bottom == 0)
                {
                    (current_element_rect, current_element_token) = self.insert_element_cache(
                        &mut parent_tree_token,
                        current_element.clone(),
                        current_element_rect,
                        current_level,
                    );

                    if current_element_left <= mouse_x
                        && current_element_right >= mouse_x
                        && current_element_top <= mouse_y
                        && current_element_bottom >= mouse_y
                    {
                        result_token = current_element_token;
                        result_rect = current_element_rect;

                        // 使用带缓存的版本获取第一个子元素
                        let first_child = if let Some(cache_request) = &self.cache_request {
                            automation_walker
                                .get_first_child_build_cache(&current_element, cache_request)
                        } else {
                            automation_walker.get_first_child(&current_element)
                        };

                        if let Ok(child) = first_child {
                            queue = Some(child.clone());
                            parent_tree_token = current_element_token;
                            parent_level = current_level;

                            current_level.next_level();

                            self.element_children_next_sibling_cache.insert(
                                parent_level,
                                ElementChildrenNextSiblingCacheItem::Element(child, current_level),
                            );

                            continue;
                        } else {
                            self.element_children_next_sibling_cache
                                .insert(current_level, ElementChildrenNextSiblingCacheItem::Leaf);
                        }
                    }
                }
            }

            // 使用带缓存的版本获取下一个兄弟元素
            let next_sibling = if let Some(cache_request) = &self.cache_request {
                automation_walker.get_next_sibling_build_cache(&current_element, cache_request)
            } else {
                automation_walker.get_next_sibling(&current_element)
            };

            match next_sibling {
                Ok(sibling) => {
                    queue = Some(sibling.clone());
                    current_level.next_element();

                    self.element_children_next_sibling_cache.insert(
                        parent_level,
                        ElementChildrenNextSiblingCacheItem::Element(sibling, current_level),
                    );
                }
                Err(_) => {
                    // 如果当前层级遍历结束了，标记已经遍历结束
                    self.element_children_next_sibling_cache
                        .insert(parent_level, ElementChildrenNextSiblingCacheItem::NoNext);
                }
            }
        }

        let element_ancestors = result_token.ancestors(&self.element_rect_tree);
        let mut result_rect_list = Vec::with_capacity(16);
        let mut previous_rect = ElementRect::from(result_rect);
        result_rect_list.push(previous_rect);
        for node in element_ancestors {
            let current_rect = ElementRect::from(node.data);
            if current_rect == previous_rect {
                continue;
            }

            if current_rect.min_x == previous_rect.max_x
                || current_rect.min_y == previous_rect.max_y
                || current_rect.min_x > previous_rect.max_x
                || current_rect.min_y > previous_rect.max_y
            {
                continue;
            }

            result_rect_list.push(current_rect);
            previous_rect = current_rect;
        }

        return Ok(result_rect_list);
    }
}

impl Drop for UIElements {
    fn drop(&mut self) {
        // 清理资源
        self.automation = None;
        self.automation_walker = None;
        self.root_element = None;
    }
}
