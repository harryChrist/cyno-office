use tauri::menu::{CheckMenuItemBuilder, Menu, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::server;
use crate::state::{show_main_window, AppState};
use crate::updater;

const MENU_OPEN: &str = "open";
const MENU_CHECK_UPDATE: &str = "check_update";
const MENU_QUIT_AND_UPDATE: &str = "quit_and_update";
const MENU_AUTOSTART: &str = "autostart";
const MENU_QUIT: &str = "quit";

/// Configura o ícone na bandeja e o menu com:
/// Abrir, Verificar atualização, Sair e atualizar (habilitado quando há pacote pronto),
/// Iniciar com o Windows (marcável) e Sair (único jeito de encerrar).
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);

    let open_item = MenuItemBuilder::with_id(MENU_OPEN, "Abrir").build(app)?;
    let check_update_item =
        MenuItemBuilder::with_id(MENU_CHECK_UPDATE, "Verificar atualização").build(app)?;
    let quit_and_update_item = MenuItemBuilder::with_id(MENU_QUIT_AND_UPDATE, "Sair e atualizar")
        .enabled(false)
        .build(app)?;
    let autostart_item = CheckMenuItemBuilder::with_id(MENU_AUTOSTART, "Iniciar com o Windows")
        .checked(autostart_enabled)
        .build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItemBuilder::with_id(MENU_QUIT, "Sair").build(app)?;

    if let Ok(mut guard) = app.state::<AppState>().tray_update_item.lock() {
        *guard = Some(quit_and_update_item.clone());
    }

    let menu = Menu::with_items(
        app,
        &[
            &open_item,
            &check_update_item,
            &quit_and_update_item,
            &autostart_item,
            &separator,
            &quit_item,
        ],
    )?;

    let autostart_handle = autostart_item.clone();

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Cyno Office")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            MENU_OPEN => show_main_window(app),
            MENU_CHECK_UPDATE => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    updater::check_and_download(&handle, true).await;
                });
            }
            MENU_QUIT_AND_UPDATE => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    updater::apply_pending_and_exit(handle).await;
                });
            }
            MENU_AUTOSTART => {
                let manager = app.autolaunch();
                let currently_enabled = manager.is_enabled().unwrap_or(false);
                let result = if currently_enabled {
                    manager.disable()
                } else {
                    manager.enable()
                };
                if let Err(err) = result {
                    eprintln!("[cyno-tray] falha ao alternar autostart: {err}");
                }
                let next_state = manager.is_enabled().unwrap_or(currently_enabled);
                let _ = autostart_handle.set_checked(next_state);
            }
            MENU_QUIT => {
                let state = app.state::<AppState>();
                server::stop_server(&state);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}
