use std::path::PathBuf;
use std::sync::Mutex;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_updater::Update;

/// Atualização já baixada em segundo plano, aguardando o usuário encerrar ou reiniciar.
pub struct PendingUpdate {
    pub version: String,
    pub update: Update,
    pub bytes: Vec<u8>,
}

/// Estado compartilhado da casca desktop.
pub struct AppState {
    pub data_dir: PathBuf,
    pub web_port: u16,
    pub api_port: u16,
    pub sidecar: Mutex<Option<CommandChild>>,
    pub pending_update: Mutex<Option<PendingUpdate>>,
    pub tray_update_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    pub last_notification_route: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf, web_port: u16, api_port: u16) -> Self {
        Self {
            data_dir,
            web_port,
            api_port,
            sidecar: Mutex::new(None),
            pending_update: Mutex::new(None),
            tray_update_item: Mutex::new(None),
            last_notification_route: Mutex::new(None),
        }
    }

    pub fn web_url(&self) -> String {
        format!("http://localhost:{}", self.web_port)
    }
}

/// Traz a janela principal à frente (desminimiza, mostra e foca).
pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Navega a janela principal para a URL do servidor local (útil após o sidecar ficar saudável).
pub fn navigate_main_window(app: &AppHandle, url_str: &str) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(url) = Url::parse(url_str) {
            let _ = window.navigate(url);
        }
    }
}
