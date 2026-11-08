// src-tauri/src/state.rs
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::File,
    io::BufWriter,
    path::PathBuf,
    sync::Arc,
};
use sha2::Sha256;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageLocationConfig {
    pub version: u32,
    #[serde(rename = "boardsDir")]
    pub boards_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LastBoardConfig {
    pub id: Option<String>,
    pub at: Option<u64>,
    #[serde(rename = "byFolder", default)]
    pub by_folder: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardMeta {
    pub id: String,
    pub name: String,
    pub objects: usize,
    pub thumb: Option<String>,
    pub origin: Option<String>,
    pub properties: Option<serde_json::Value>,
    pub tags: Option<Vec<String>>,
    pub aliases: Option<Vec<String>>,
    #[serde(default)]
    pub modified: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardIndexEntry {
    pub mtime: u64,
    pub size: u64,
    pub meta: BoardMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoardIndexFile {
    pub version: u32,
    #[serde(default)]
    pub dirs: HashMap<String, HashMap<String, BoardIndexEntry>>,
}

impl Default for BoardIndexFile {
    fn default() -> Self {
        Self {
            version: 1,
            dirs: HashMap::new(),
        }
    }
}

pub struct ActiveRecording {
    pub temp_path: PathBuf,
    pub writer: BufWriter<File>,
    pub hasher: Sha256,
    pub bytes_written: u64,
}

pub struct AppState {
    pub user_data_dir: PathBuf,
    pub default_boards_dir: PathBuf,
    pub active_boards_dir: RwLock<PathBuf>,
    pub previous_boards_dirs: Mutex<HashMap<String, PathBuf>>, // token -> old dir
    pub board_index: Mutex<BoardIndexFile>,
    pub recordings: Mutex<HashMap<String, ActiveRecording>>,
    pub flush_waiters: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    pub active_editor_window: RwLock<String>,
    pub language: RwLock<String>,
    pub last_clipboard_sig: RwLock<Option<String>>,
}

impl AppState {
    pub fn new(user_data_dir: PathBuf, document_dir: PathBuf) -> Arc<Self> {
        let _ = std::fs::create_dir_all(&user_data_dir);
        let default_boards_dir = document_dir.join("GaussBoard");

        // Load custom storage-location.json if configured
        let storage_cfg_path = user_data_dir.join("storage-location.json");
        let active_dir = std::fs::read_to_string(&storage_cfg_path)
            .ok()
            .and_then(|s| serde_json::from_str::<StorageLocationConfig>(&s).ok())
            .map(|cfg| PathBuf::from(cfg.boards_dir))
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| default_boards_dir.clone());

        let _ = std::fs::create_dir_all(&active_dir);
        let _ = std::fs::create_dir_all(active_dir.join("assets"));

        // Load persistent board-index.json
        let index_path = user_data_dir.join("board-index.json");
        let board_index = std::fs::read_to_string(&index_path)
            .ok()
            .and_then(|s| serde_json::from_str::<BoardIndexFile>(&s).ok())
            .unwrap_or_default();

        Arc::new(Self {
            user_data_dir,
            default_boards_dir,
            active_boards_dir: RwLock::new(active_dir),
            previous_boards_dirs: Mutex::new(HashMap::new()),
            board_index: Mutex::new(board_index),
            recordings: Mutex::new(HashMap::new()),
            flush_waiters: Mutex::new(HashMap::new()),
            active_editor_window: RwLock::new("main".to_string()),
            language: RwLock::new("en".to_string()),
            last_clipboard_sig: RwLock::new(None),
        })
    }

    pub fn boards_dir(&self) -> PathBuf {
        self.active_boards_dir.read().clone()
    }

    pub fn assets_dir(&self) -> PathBuf {
        let dir = self.boards_dir().join("assets");
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    pub fn persist_index(&self, index: &BoardIndexFile) {
        let index_path = self.user_data_dir.join("board-index.json");
        if let Ok(bytes) = serde_json::to_vec(index) {
            let _ = crate::storage::atomic_write_bytes(&index_path, &bytes);
        }
    }
}
