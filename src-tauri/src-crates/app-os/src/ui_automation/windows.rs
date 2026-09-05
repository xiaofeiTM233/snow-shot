use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::mem;
use std::time::{Duration, Instant};

use atree::Arena;
use atree::Token;
use rtree_rs::{RTree, Rect};
use uiautomation::UIAutomation;
use uiautomation::UIElement;
use uiautomation::types::{Handle, TreeScope, UIProperty};

use snow_shot_app_shared::ElementRect;
use snow_shot_app_utils::monitor_info::MonitorList;
use xcap::Window;

use super::ElementLevel;
use super::UIAutomationError;

/**
 * 点查询结果
 */
pub enum PointQueryResult {
    /**
     * 已缓存元素的矩形链（从最内层到最外层）
     */
    Rects(Vec<ElementRect>),
    /**
     * 命中的窗口子树尚未枚举，需要先全量枚举该窗口
     */
    NeedsEnumeration {
        window_index: i32,
        /**
         * 枚举期间/失败时的兜底矩形链（窗口级）
         */
        fallback: Vec<ElementRect>,
    },
}

/**
 * 窗口子树枚举任务描述
 */
pub struct WindowEnumerationTarget {
    /**
     * 发起枚举时的会话 ID，用于合并时丢弃过期结果
     */
    pub session_id: u64,
    pub window_index: i32,
    pub hwnd: isize,
    pub window_rect: (i32, i32, i32, i32),
}

/**
 * 全量枚举得到的扁平元素列表
 * 按前序排列（父元素先于子元素出现），parent_index 指向列表中父元素的下标
 */
pub struct WindowEnumerationResult {
    pub elements: Vec<FlatElement>,
}

#[derive(Debug, Clone, Copy)]
pub struct FlatElement {
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
    /**
     * 父元素在列表中的下标，-1 表示窗口的直接子元素
     */
    pub parent_index: i32,
}

/**
 * 全量枚举的深度上限，防止异常深的 UIA 树
 */
const ENUMERATION_MAX_DEPTH: u32 = 64;

/**
 * 全量枚举的元素数量上限，防止异常多的元素拖垮合并耗时与内存
 */
const ENUMERATION_MAX_ELEMENTS: usize = 30000;

pub struct UIElements {
    /**
     * 元素矩形空间索引，用于鼠标点命中查询
     */
    element_cache: RTree<2, i32, ElementLevel>,
    /**
     * 元素层级 → 矩形树节点
     */
    element_level_map: HashMap<ElementLevel, Token>,
    /**
     * 元素矩形树，用于取命中元素的祖先链
     */
    element_rect_tree: Arena<uiautomation::types::Rect>,
    window_rect_map: HashMap<ElementLevel, uiautomation::types::Rect>,
    window_index_level_map: HashMap<i32, ElementLevel>,
    window_app_name_map: HashMap<i32, String>,
    /**
     * 窗口索引 → 原生 HWND，供子树全量枚举使用
     */
    window_hwnd_map: HashMap<i32, isize>,
    blacklisted_window_indices: HashSet<i32>,
    /**
     * 已完成子树全量枚举的窗口
     */
    enumerated_windows: HashSet<i32>,
    /**
     * 子树枚举进行中的窗口
     */
    enumerating_windows: HashSet<i32>,
    /**
     * 子树枚举失败/超时的窗口，本会话内不再重试
     */
    enumeration_failed_windows: HashSet<i32>,
    root_rect: Option<uiautomation::types::Rect>,
    /**
     * 截图会话 ID，init_cache 时递增，用于丢弃跨会话的过期枚举结果
     */
    session_id: u64,
}

impl UIElements {
    pub fn new() -> Self {
        Self {
            element_cache: RTree::new(),
            element_level_map: HashMap::new(),
            element_rect_tree: Arena::new(),
            window_rect_map: HashMap::new(),
            window_index_level_map: HashMap::new(),
            window_app_name_map: HashMap::new(),
            window_hwnd_map: HashMap::new(),
            blacklisted_window_indices: HashSet::new(),
            enumerated_windows: HashSet::new(),
            enumerating_windows: HashSet::new(),
            enumeration_failed_windows: HashSet::new(),
            root_rect: None,
            session_id: 0,
        }
    }

    pub fn init(&mut self) -> Result<(), UIAutomationError> {
        // 仅校验 UIA 可用性；实际枚举都在独立线程中各自创建 UIAutomation 实例
        UIAutomation::new()?;
        Ok(())
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
     * 只枚举到窗口级（无 COM 调用）；窗口内的子元素在鼠标首次进入时全量枚举
     */
    pub fn init_cache(&mut self) -> Result<(), UIAutomationError> {
        self.element_rect_tree = Arena::new();
        self.element_cache = RTree::new();
        self.element_level_map.clear();
        self.window_rect_map.clear();
        self.window_index_level_map.clear();
        self.window_app_name_map.clear();
        self.window_hwnd_map.clear();
        self.blacklisted_window_indices.clear();
        self.enumerated_windows.clear();
        self.enumerating_windows.clear();
        self.enumeration_failed_windows.clear();
        self.root_rect = None;
        self.session_id += 1;

        // 桌面的窗口索引应该是最高，因为其优先级最低
        let monitors_bounding_box = MonitorList::all(true).get_monitors_bounding_box();
        let root_rect = uiautomation::types::Rect::new(
            monitors_bounding_box.min_x,
            monitors_bounding_box.min_y,
            monitors_bounding_box.max_x,
            monitors_bounding_box.max_y,
        );
        self.root_rect = Some(root_rect);

        let root_level = ElementLevel::root();
        let mut root_token = self.element_rect_tree.new_node(root_rect);
        self.element_cache.insert(
            Self::convert_element_rect_to_rtree_rect(root_rect),
            root_level.clone(),
        );
        self.element_level_map.insert(root_level, root_token);

        // 遍历所有窗口。按 xcap 原生 z() 值（越大越靠近顶层）降序排列，
        // 使最前面的窗口排在最前、拿到最小 window_index、层级最高。
        let mut windows = Window::all().unwrap_or_default();
        windows.sort_by_key(|w| std::cmp::Reverse(w.z().unwrap_or(0)));

        #[cfg(debug_assertions)]
        for (i, w) in windows.iter().enumerate() {
            log::debug!(
                "[init_cache] window[{i}] z={} title={:?}",
                w.z().unwrap_or(-1),
                w.title().unwrap_or_default()
            );
        }

        let mut current_level = ElementLevel::root();
        current_level.window_index = 0;
        current_level.next_level();

        for window in windows.iter() {
            if window.is_minimized().unwrap_or(true) {
                continue;
            }

            let window_title = match window.title() {
                Ok(title) => title,
                Err(_) => continue,
            };
            if window_title.eq("Shell Handwriting Canvas") || window_title.eq("Snow Shot - Draw") {
                continue;
            }

            // 官方原版 xcap 不再提供 Window::hwnd()，改用本地化映射得到原生 HWND。
            // 用宽松匹配兜底，避免最前窗口因几何偏差匹配失败而被丢弃。
            let window_hwnd =
                match snow_shot_app_utils::sys::windows::hwnd::find_window_hwnd_loose(window) {
                    Some(hwnd) => hwnd,
                    None => continue,
                };

            // 使用 xcap 公开的窗口几何
            let window_rect = uiautomation::types::Rect::new(
                window.x().unwrap_or(0),
                window.y().unwrap_or(0),
                window.x().unwrap_or(0) + window.width().unwrap_or(0) as i32,
                window.y().unwrap_or(0) + window.height().unwrap_or(0) as i32,
            );

            current_level.window_index += 1;
            current_level.next_element();

            let app_name = window.app_name().unwrap_or_default();
            let (window_rect, _) = self.insert_rect_cache(
                &mut root_token,
                window_rect,
                current_level.clone(),
            );

            self.window_rect_map
                .insert(current_level.clone(), window_rect);
            self.window_index_level_map
                .insert(current_level.window_index, current_level.clone());
            self.window_app_name_map
                .insert(current_level.window_index, app_name);
            self.window_hwnd_map
                .insert(current_level.window_index, window_hwnd.0 as isize);
        }

        Ok(())
    }

    /**
     * 设置子元素查找黑名单
     * 黑名单中的窗口标题对应的窗口不会被枚举子元素，需完全匹配
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

    /**
     * 插入矩形缓存：空间索引 + 矩形树 + 层级映射
     */
    fn insert_rect_cache(
        &mut self,
        parent_token: &mut Token,
        element_rect: uiautomation::types::Rect,
        element_level: ElementLevel,
    ) -> (uiautomation::types::Rect, Token) {
        let element_rect = Self::normalize_rect(element_rect);

        self.element_cache.insert(
            Self::convert_element_rect_to_rtree_rect(element_rect),
            element_level.clone(),
        );

        let current_node = self.element_rect_tree.new_node(element_rect);
        parent_token
            .append_node(&mut self.element_rect_tree, current_node)
            .unwrap();
        self.element_level_map.insert(element_level, current_node);

        (element_rect, current_node)
    }

    /**
     * 空间索引点查询，取包含该点的层级最高的元素
     */
    fn get_cached_hit(
        &self,
        mouse_x: i32,
        mouse_y: i32,
    ) -> Option<(ElementLevel, uiautomation::types::Rect, Token)> {
        let hit_rects = self.element_cache.search(Rect::new_point([mouse_x, mouse_y]));

        let mut max_level = ElementLevel::root();
        let mut max_level_rect = None;
        for rect in hit_rects {
            if max_level.cmp(&rect.data) == Ordering::Less {
                max_level = rect.data.clone();
                max_level_rect = Some(rect.rect);
            }
        }
        let rtree_rect = max_level_rect?;
        let rtree_rect = uiautomation::types::Rect::new(
            rtree_rect.min[0],
            rtree_rect.min[1],
            rtree_rect.max[0],
            rtree_rect.max[1],
        );
        let token = *self.element_level_map.get(&max_level)?;

        Some((max_level, rtree_rect, token))
    }

    /**
     * 取命中元素的矩形链（从最内层到最外层），去掉重复与不相邻的矩形
     */
    fn build_result_rect_list(
        &self,
        token: Token,
        rect: uiautomation::types::Rect,
    ) -> Vec<ElementRect> {
        let element_ancestors = token.ancestors(&self.element_rect_tree);
        let mut result_rect_list = Vec::with_capacity(16);
        let mut previous_rect = ElementRect::from(rect);
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

        result_rect_list
    }

    /**
     * 获取鼠标位置处的候选矩形链（纯本地查询，无 COM 调用）
     */
    pub fn get_element_rects_from_point(
        &self,
        mouse_x: i32,
        mouse_y: i32,
    ) -> Result<PointQueryResult, UIAutomationError> {
        let (hit_level, hit_rect, hit_token) = match self.get_cached_hit(mouse_x, mouse_y) {
            Some(hit) => hit,
            None => {
                // 鼠标在所有显示器范围外
                return Ok(match self.root_rect {
                    Some(root_rect) => PointQueryResult::Rects(vec![ElementRect::from(root_rect)]),
                    None => PointQueryResult::Rects(Vec::new()),
                });
            }
        };

        // 黑名单中的窗口不枚举子元素，由前端回退到窗口级矩形
        if self
            .blacklisted_window_indices
            .contains(&hit_level.window_index)
        {
            return Err(UIAutomationError::Blacklisted);
        }

        // 窗口子树尚未枚举：本次先返回窗口级兜底矩形，由命令层触发全量枚举
        if self.window_hwnd_map.contains_key(&hit_level.window_index)
            && !self.enumerated_windows.contains(&hit_level.window_index)
            && !self.enumerating_windows.contains(&hit_level.window_index)
            && !self
                .enumeration_failed_windows
                .contains(&hit_level.window_index)
        {
            return Ok(PointQueryResult::NeedsEnumeration {
                window_index: hit_level.window_index,
                fallback: self.build_result_rect_list(hit_token, hit_rect),
            });
        }

        Ok(PointQueryResult::Rects(
            self.build_result_rect_list(hit_token, hit_rect),
        ))
    }

    /**
     * 开始枚举指定窗口的子树
     * 返回 None 表示已在枚举中、已完成、已失败或无法枚举（缺少 HWND）
     */
    pub fn begin_window_enumeration(
        &mut self,
        window_index: i32,
    ) -> Option<WindowEnumerationTarget> {
        if self.enumerating_windows.contains(&window_index)
            || self.enumerated_windows.contains(&window_index)
            || self
                .enumeration_failed_windows
                .contains(&window_index)
        {
            return None;
        }

        let hwnd = *self.window_hwnd_map.get(&window_index)?;
        let window_level = self.window_index_level_map.get(&window_index)?;
        let window_rect = self.window_rect_map.get(window_level)?;
        self.enumerating_windows.insert(window_index);

        Some(WindowEnumerationTarget {
            session_id: self.session_id,
            window_index,
            hwnd,
            window_rect: (
                window_rect.get_left(),
                window_rect.get_top(),
                window_rect.get_right(),
                window_rect.get_bottom(),
            ),
        })
    }

    /**
     * 预热：选择需要后台预枚举的窗口
     * 鼠标所在窗口优先，其余按 z 序（window_index 升序，越靠前越优先）补充
     */
    pub fn begin_prewarm_enumeration(
        &mut self,
        mouse_x: i32,
        mouse_y: i32,
        max_windows: usize,
    ) -> Vec<WindowEnumerationTarget> {
        let mut targets = Vec::new();
        if max_windows == 0 {
            return targets;
        }

        let mut candidate_indices: Vec<i32> = Vec::new();

        // 鼠标所在窗口优先
        if let Some((hit_level, _, _)) = self.get_cached_hit(mouse_x, mouse_y) {
            if self.window_hwnd_map.contains_key(&hit_level.window_index) {
                candidate_indices.push(hit_level.window_index);
            }
        }

        // 其余窗口按 z 序补充
        let mut sorted_indices: Vec<i32> = self.window_hwnd_map.keys().copied().collect();
        sorted_indices.sort_unstable();
        for index in sorted_indices {
            if candidate_indices.len() >= max_windows {
                break;
            }
            if !candidate_indices.contains(&index) {
                candidate_indices.push(index);
            }
        }

        for window_index in candidate_indices {
            // 黑名单窗口不预热（元素级查询本来就会跳过它们）
            if self.blacklisted_window_indices.contains(&window_index) {
                continue;
            }

            if let Some(target) = self.begin_window_enumeration(window_index) {
                targets.push(target);
            }
            if targets.len() >= max_windows {
                break;
            }
        }

        targets
    }

    /**
     * 合并全量枚举结果：按前序与父元素下标重建元素层级，插入空间索引与矩形树
     */
    pub fn merge_window_enumeration(
        &mut self,
        window_index: i32,
        session_id: u64,
        result: WindowEnumerationResult,
    ) {
        // 会话已切换：过期结果直接丢弃，不触碰新会话的枚举状态
        // （否则会误删新会话同窗口的"枚举中"标记，导致重复枚举）
        if session_id != self.session_id {
            return;
        }

        self.enumerating_windows.remove(&window_index);

        let Some(window_level) = self.window_index_level_map.get(&window_index).cloned() else {
            return;
        };
        let Some(window_token) = self.element_level_map.get(&window_level).copied() else {
            return;
        };

        let mut levels: Vec<ElementLevel> = Vec::with_capacity(result.elements.len());
        let mut tokens: Vec<Token> = Vec::with_capacity(result.elements.len());
        // 同一父元素的子元素按枚举顺序递增 element_index
        let mut sibling_counters: HashMap<i32, i32> = HashMap::new();

        for item in result.elements.iter() {
            let (parent_level, parent_token) = if item.parent_index < 0 {
                (window_level.clone(), window_token)
            } else {
                let parent = item.parent_index as usize;
                (levels[parent].clone(), tokens[parent])
            };

            let mut level = parent_level;
            level.next_level();
            let sibling_index = sibling_counters.entry(item.parent_index).or_insert(0);
            level.element_index = *sibling_index;
            *sibling_index += 1;

            let rect = uiautomation::types::Rect::new(
                item.min_x,
                item.min_y,
                item.max_x,
                item.max_y,
            );
            let node = self.element_rect_tree.new_node(rect);
            parent_token
                .append_node(&mut self.element_rect_tree, node)
                .unwrap();
            self.element_cache
                .insert(Self::convert_element_rect_to_rtree_rect(rect), level.clone());
            self.element_level_map.insert(level.clone(), node);
            levels.push(level);
            tokens.push(node);
        }

        self.enumerated_windows.insert(window_index);
    }

    /**
     * 标记窗口子树枚举失败/超时，本会话内不再重试
     */
    pub fn mark_window_enumeration_failed(&mut self, window_index: i32, session_id: u64) {
        // 会话已切换：过期标记直接丢弃，不触碰新会话的枚举状态
        if session_id != self.session_id {
            return;
        }

        self.enumerating_windows.remove(&window_index);
        self.enumeration_failed_windows.insert(window_index);
    }
}

/**
 * 全量枚举窗口子树，返回扁平化的元素矩形列表（前序：父元素先于子元素出现）
 *
 * 该函数应在独立线程中调用：
 * - UIAutomation 实例在当前线程内创建（CoInitializeEx MTA），COM 指针不跨线程传递
 * - soft_deadline_ms 为软超时，在元素之间检查，超时后返回已枚举的部分结果；
 *   单次 COM 调用无法被打断，若 provider 挂起，最坏情况阻塞在这一次调用上
 */
pub fn enumerate_window_subtree(
    hwnd: isize,
    window_rect: (i32, i32, i32, i32),
    soft_deadline_ms: u64,
) -> Result<WindowEnumerationResult, UIAutomationError> {
    let window_rect =
        uiautomation::types::Rect::new(window_rect.0, window_rect.1, window_rect.2, window_rect.3);

    let automation = UIAutomation::new()?;
    let walker = automation.get_content_view_walker()?;

    // 创建缓存请求，预先缓存常用属性，减少跨进程调用。
    // 只缓存下方实际读取的 BoundingRectangle 与 IsOffscreen 两个属性；
    // ControlType 为旧实时遍历的遗留缓存，当前枚举器无任何读取方，
    // 多余属性会增加每个元素的序列化开销，故不再缓存
    let cache_request = automation.create_cache_request()?;
    cache_request.add_property(UIProperty::BoundingRectangle)?;
    cache_request.add_property(UIProperty::IsOffscreen)?;
    cache_request.set_tree_scope(TreeScope::Element)?;

    let window_element = automation.element_from_handle(Handle::from(hwnd))?;

    let start_time = Instant::now();
    let mut elements: Vec<FlatElement> = Vec::new();

    struct Frame {
        element: UIElement,
        /**
         * 最近一个已发射祖先在列表中的下标，-1 表示窗口（窗口矩形本身已在缓存中）
         */
        visual_parent_index: i32,
        /**
         * 最近一个已发射祖先（或窗口）的矩形，用于折叠同矩形的装饰性容器
         */
        visual_parent_rect: uiautomation::types::Rect,
        depth: u32,
        /**
         * 窗口元素本身不发射（窗口矩形已在缓存中），只发射其后代
         */
        emit: bool,
    }
    let mut stack: Vec<Frame> = vec![Frame {
        element: window_element,
        visual_parent_index: -1,
        visual_parent_rect: window_rect,
        depth: 0,
        emit: false,
    }];

    while let Some(frame) = stack.pop() {
        if elements.len() >= ENUMERATION_MAX_ELEMENTS {
            break;
        }
        if start_time.elapsed() >= Duration::from_millis(soft_deadline_ms) {
            break;
        }

        let mut self_index = frame.visual_parent_index;
        let mut self_rect = frame.visual_parent_rect;
        if frame.emit {
            // 跳过离屏元素，其子树也一并跳过
            if frame.element.is_cached_offscreen().unwrap_or(true) {
                continue;
            }

            let Ok(raw_rect) = frame.element.get_cached_bounding_rectangle() else {
                continue;
            };

            // 矩形纠正并裁剪到窗口范围内，裁剪后为空说明元素在窗口外
            let rect = UIElements::clip_rect(UIElements::normalize_rect(raw_rect), window_rect);
            if rect.get_left() >= rect.get_right() || rect.get_top() >= rect.get_bottom() {
                continue;
            }

            // 矩形与已发射父元素完全一致的装饰性容器不单独发射，
            // 其子元素挂到最近的已发射祖先（结果链本就会去重同矩形层级）
            if rect != frame.visual_parent_rect {
                self_index = elements.len() as i32;
                self_rect = rect;
                elements.push(FlatElement {
                    min_x: rect.get_left(),
                    min_y: rect.get_top(),
                    max_x: rect.get_right(),
                    max_y: rect.get_bottom(),
                    parent_index: frame.visual_parent_index,
                });
            }
        }

        if frame.depth + 1 > ENUMERATION_MAX_DEPTH {
            continue;
        }

        // 收集子元素后逆序入栈，保证列表为前序（父先于子，兄弟按原顺序）
        let mut children: Vec<UIElement> = Vec::new();
        if let Ok(first_child) = walker.get_first_child_build_cache(&frame.element, &cache_request)
        {
            let mut current = first_child;
            loop {
                children.push(current);
                match walker.get_next_sibling_build_cache(
                    &children[children.len() - 1],
                    &cache_request,
                ) {
                    Ok(next) => current = next,
                    Err(_) => break,
                }
            }
        }

        for child in children.into_iter().rev() {
            stack.push(Frame {
                element: child,
                visual_parent_index: self_index,
                visual_parent_rect: self_rect,
                depth: frame.depth + 1,
                emit: true,
            });
        }
    }

    Ok(WindowEnumerationResult { elements })
}
