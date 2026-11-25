mod commands;
mod server;
mod state;
mod tray;
mod updater;

use std::time::Duration;

use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::server::{DEFAULT_API_PORT, DEFAULT_WEB_PORT};
use crate::state::{navigate_main_window, show_main_window, AppState};

const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

pub fn run() {
    let start_hidden = std::env::args().any(|arg| arg == "--hidden");

    let builder = tauri::Builder::default()
        // Instância única deve ser o primeiro plugin: segunda abertura apenas mostra a janela.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::pick_folder,
            commands::desktop_notify,
            commands::get_data_dir,
            commands::is_update_ready,
        ])
        // Fechar a janela pelo X só a esconde; o único jeito de encerrar é "Sair" na bandeja.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            let data_dir = server::resolve_data_dir(app.handle());
            let web_port = server::env_port("WEB_PORT", DEFAULT_WEB_PORT);
            let api_port = server::env_port("PORT", DEFAULT_API_PORT);

            app.manage(AppState::new(data_dir, web_port, api_port));

            if let Err(err) = tray::setup_tray(app.handle()) {
                eprintln!("[cyno-desktop] erro ao criar ícone na bandeja: {err}");
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Se havia atualização pendente do encerramento anterior, aplica antes de subir o servidor.
                if updater::apply_pending_on_startup(&handle).await {
                    handle.exit(0);
                    return;
                }

                let (web_url, web_port, api_port) = {
                    let state = handle.state::<AppState>();
                    if let Err(err) = server::start_server(&handle, &state) {
                        eprintln!("[cyno-desktop] aviso ao iniciar sidecar: {err}");
                    }
                    (state.web_url(), state.web_port, state.api_port)
                };

                let healthy = server::wait_for_health(web_port, api_port, HEALTH_TIMEOUT).await;
                if !healthy {
                    eprintln!(
                        "[cyno-desktop] servidor não respondeu em /api/health após {}s",
                        HEALTH_TIMEOUT.as_secs()
                    );
                }

                navigate_main_window(&handle, &web_url);
                if !start_hidden {
                    show_main_window(&handle);
                }

                updater::start_background_updater(handle);
            });

            Ok(())
        });

    match builder.build(tauri::generate_context!()) {
        Ok(app) => {
            app.run(|app_handle, event| {
                if let RunEvent::Exit = event {
                    let state = app_handle.state::<AppState>();
                    server::stop_server(&state);
                }
            });
        }
        Err(err) => {
            eprintln!("[cyno-desktop] erro fatal ao iniciar o aplicativo Tauri: {err}");
        }
    }
}
