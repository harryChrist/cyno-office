use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

use crate::state::AppState;

/// Abre o diálogo nativo do sistema para escolher uma pasta.
/// Devolve o caminho selecionado ou `None` se o usuário cancelar.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Escolher pasta")
        .pick_folder(move |folder| {
            let path = folder
                .and_then(|f| f.into_path().ok())
                .map(|p| p.to_string_lossy().into_owned());
            let _ = tx.send(path);
        });

    rx.await
        .map_err(|_| "Diálogo de pasta encerrado sem resposta".to_string())
}

/// Dispara uma notificação nativa do Windows (via `tauri-plugin-notification`).
/// Guarda `on_click_route` no estado para futura navegação ao ativar a notificação.
#[tauri::command]
pub fn desktop_notify(
    app: AppHandle,
    state: State<'_, AppState>,
    title: String,
    body: String,
    on_click_route: Option<String>,
) -> Result<bool, String> {
    if let Ok(mut guard) = state.last_notification_route.lock() {
        *guard = on_click_route;
    }

    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map(|()| true)
        .map_err(|e| format!("falha ao enviar notificação nativa: {e}"))
}

/// Informa a pasta de dados configurada pela casca.
#[tauri::command]
pub fn get_data_dir(state: State<'_, AppState>) -> String {
    state.data_dir.to_string_lossy().into_owned()
}

/// Devolve a versão pronta para instalação ao sair, ou `None` se não houver atualização baixada.
#[tauri::command]
pub fn is_update_ready(state: State<'_, AppState>) -> Option<String> {
    state
        .pending_update
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p.version.clone()))
}
