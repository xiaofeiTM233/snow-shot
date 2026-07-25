use dashmap::{DashMap, DashSet};
use std::{fs, path::PathBuf, sync::RwLock};
use tauri::Manager;

/**
 * 配置文件每个窗口同步时都会读取一次
 * 通过统一读取提速
 */
pub struct FileCacheService {
    file_cache: DashMap<PathBuf, String>,
    exists_path_cache: DashSet<PathBuf>,
    env_path_cache: DashMap<String, PathBuf>,
    is_portable: RwLock<Option<bool>>,
}

const APP_CONFIG_DIR: &str = "app_config_dir";
const APP_CONFIG_BASE_DIR: &str = "app_config_base_dir";
const APP_CONFIG_DIR_NAME: &str = "configs";
const APP_CUSTOM_CONFIG_DIR_DATA_FILE_NAME: &str = "__custom_config_dir";
const APP_CACHE_DIR: &str = "app_cache_dir";
const APP_CUSTOM_CACHE_DIR_DATA_FILE_NAME: &str = "__custom_cache_dir";
#[cfg(target_os = "windows")]
const APP_PORTABLE_DIR_DATA_FILE_NAME: &str = "__portable";

impl FileCacheService {
    pub fn new() -> Self {
        Self {
            file_cache: DashMap::new(),
            exists_path_cache: DashSet::new(),
            env_path_cache: DashMap::new(),
            is_portable: RwLock::new(None),
        }
    }

    pub fn is_portable_app(&self) -> bool {
        if let Ok(is_portable) = self.is_portable.read() {
            if let Some(is_portable) = is_portable.as_ref() {
                return *is_portable;
            }
        }

        let is_portable = self.get_app_portable_config_dir().is_some();
        *self.is_portable.write().unwrap() = Some(is_portable);
        is_portable
    }

    fn get_app_global_config_dir(&self, app: &tauri::AppHandle) -> Result<PathBuf, String> {
        Ok(app
            .path()
            .app_config_dir()
            .map_err(|e| e.to_string())?
            .join(APP_CONFIG_DIR_NAME))
    }

    /// 获取便携版配置目录
    fn get_app_portable_config_dir(&self) -> Option<PathBuf> {
        #[cfg(not(target_os = "windows"))]
        {
            return None;
        }

        // 判断是否是便携版
        #[cfg(target_os = "windows")]
        {
            // 获取应用程序所在目录
            use std::env;
            let exe_path = match env::current_exe() {
                Ok(path) => path,
                Err(_) => return None,
            };

            let exe_dir_path = match exe_path.parent() {
                Some(path) => path,
                None => return None,
            };

            let portable_config_file_path = exe_dir_path.join(APP_PORTABLE_DIR_DATA_FILE_NAME);
            if portable_config_file_path.exists() {
                return Some(exe_dir_path.to_path_buf().join(APP_CONFIG_DIR_NAME));
            } else {
                return None;
            }
        }
    }

    fn get_app_custom_config_dir(&self, app: &tauri::AppHandle) -> Option<PathBuf> {
        let app_data_config_dir = match app.path().app_config_dir() {
            Ok(path) => path,
            Err(_) => return None,
        };

        let custom_config_dir_data_file =
            app_data_config_dir.join(APP_CUSTOM_CONFIG_DIR_DATA_FILE_NAME);

        let path = match fs::read_to_string(custom_config_dir_data_file) {
            Ok(path) => path,
            Err(_) => return None,
        };
        let path = PathBuf::from(path);

        if !path.exists() {
            return None;
        }

        Some(path.join(APP_CONFIG_DIR_NAME))
    }

    pub fn create_custom_config_dir(
        &self,
        app: &tauri::AppHandle,
        path: PathBuf,
    ) -> Result<(), String> {
        let local_config_dir = path.join(APP_CONFIG_DIR_NAME);

        if !local_config_dir.exists() {
            fs::create_dir_all(local_config_dir).map_err(|e| e.to_string())?;
        }

        let path = match path.to_str() {
            Some(path) => path,
            None => return Err(String::from("[create_custom_config_dir] Invalid path")),
        };

        // 写入到文件中记录下路径
        let app_data_config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;

        let custom_config_dir_data_file =
            app_data_config_dir.join(APP_CUSTOM_CONFIG_DIR_DATA_FILE_NAME);

        fs::write(custom_config_dir_data_file, path.as_bytes()).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_app_config_dir(&self, app: &tauri::AppHandle) -> Result<PathBuf, String> {
        if let Some(path) = self.env_path_cache.get(APP_CONFIG_DIR) {
            return Ok(path.clone());
        }

        let local_config_dir = match self.get_app_custom_config_dir(app) {
            Some(path) => {
                if path.exists() {
                    Some(path)
                } else {
                    None
                }
            }
            None => None,
        };

        let path = match local_config_dir {
            Some(path) => path,
            None => self
                .get_app_portable_config_dir()
                .unwrap_or(self.get_app_global_config_dir(app)?),
        };

        self.env_path_cache
            .insert(APP_CONFIG_DIR.to_string(), path.clone());

        Ok(path)
    }

    pub fn get_app_config_base_dir(&self, app: &tauri::AppHandle) -> Result<PathBuf, String> {
        if let Some(path) = self.env_path_cache.get(APP_CONFIG_BASE_DIR) {
            return Ok(path.clone());
        }

        let path = self.get_app_config_dir(app)?;
        let path = path.parent().unwrap().to_path_buf();

        self.env_path_cache
            .insert(APP_CONFIG_BASE_DIR.to_string(), path.clone());

        Ok(path)
    }

    /// 获取自定义的缓存目录（通过标记文件记录）
    fn get_app_custom_cache_dir(&self, app: &tauri::AppHandle) -> Option<PathBuf> {
        let app_data_config_dir = match app.path().app_config_dir() {
            Ok(path) => path,
            Err(_) => return None,
        };

        let custom_cache_dir_data_file =
            app_data_config_dir.join(APP_CUSTOM_CACHE_DIR_DATA_FILE_NAME);

        let path = match fs::read_to_string(custom_cache_dir_data_file) {
            Ok(path) => path,
            Err(_) => return None,
        };
        let path = PathBuf::from(path);

        if !path.exists() {
            return None;
        }

        Some(path)
    }

    /// 设置自定义的缓存目录（将路径写入标记文件）
    pub fn create_local_cache_dir(
        &self,
        app: &tauri::AppHandle,
        path: PathBuf,
    ) -> Result<(), String> {
        if !path.exists() {
            fs::create_dir_all(path.clone()).map_err(|e| e.to_string())?;
        }

        let path = match path.to_str() {
            Some(path) => path,
            None => return Err(String::from("[create_local_cache_dir] Invalid path")),
        };

        // 写入到文件中记录下路径
        let app_data_config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;

        let custom_cache_dir_data_file =
            app_data_config_dir.join(APP_CUSTOM_CACHE_DIR_DATA_FILE_NAME);

        fs::write(custom_cache_dir_data_file, path.as_bytes()).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// 获取缓存目录（应用缓存数据的存放位置，默认跟随系统缓存目录）
    pub fn get_app_cache_dir(&self, app: &tauri::AppHandle) -> Result<PathBuf, String> {
        if let Some(path) = self.env_path_cache.get(APP_CACHE_DIR) {
            return Ok(path.clone());
        }

        let path = match self.get_app_custom_cache_dir(app) {
            Some(path) => path,
            None => app.path().app_cache_dir().map_err(|e| e.to_string())?,
        };

        self.env_path_cache
            .insert(APP_CACHE_DIR.to_string(), path.clone());

        Ok(path)
    }

    pub fn create_dir(&self, dir_path: PathBuf) -> Result<(), String> {
        if self.exists_path_cache.contains(&dir_path) {
            return Ok(());
        }

        let exists = match fs::exists(dir_path.clone()) {
            Ok(exists) => exists,
            Err(e) => {
                log::warn!(
                    "[TextFileCacheService] check dir exists failed: [{}] {}",
                    dir_path.display(),
                    e.to_string()
                );
                false
            }
        };

        if !exists {
            if let Err(e) = fs::create_dir_all(dir_path.clone()) {
                return Err(format!(
                    "[TextFileCacheService] create dir failed: [{}] {}",
                    dir_path.display(),
                    e.to_string()
                ));
            }
        }

        self.exists_path_cache.insert(dir_path);

        Ok(())
    }

    pub fn read(&self, file_path: PathBuf) -> Result<String, String> {
        if let Some(content) = self.file_cache.get(&file_path) {
            return Ok(content.clone());
        }

        // 文件读写不返回异常，提高稳定性
        let content = match fs::read_to_string(file_path.clone()) {
            Ok(content) => content,
            Err(e) => {
                log::error!(
                    "[TextFileCacheService] read failed: [{}] {}",
                    file_path.display(),
                    e.to_string()
                );

                "".to_string()
            }
        };

        Ok(content)
    }

    pub fn write(&self, file_path: PathBuf, content: String) -> Result<(), String> {
        // 文件读写不返回异常，提高稳定性
        if let Err(e) = fs::write(file_path.clone(), content.clone()) {
            log::error!(
                "[TextFileCacheService] write file failed: [{}] {}",
                file_path.display(),
                e.to_string()
            );
        };

        self.file_cache.insert(file_path, content.clone());

        Ok(())
    }

    pub fn clear(&self) {
        self.file_cache.clear();
    }
}
