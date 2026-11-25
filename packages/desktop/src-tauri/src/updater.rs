use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;

use crate::server;
use crate::state::{AppState, PendingUpdate};

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const INITIAL_DELAY: Duration = Duration::from_secs(15);
const PENDING_FLAG_NAME: &str = "pending-update.flag";

/// Inicia a rotina em segundo plano: verifica logo após abrir e depois a cada 6 horas.
/// Nunca aplica a atualização no meio do trabalho — apenas baixa e marca como pronta.
pub fn start_background_updater(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(INITIAL_DELAY).await;
        loop {
            check_and_download(&app, false).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// Verifica se existe atualização e, se houver, baixa em segundo plano sem interromper o usuário.
pub async fn check_and_download(app: &AppHandle, notify_if_current: bool) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(err) => {
            eprintln!("[cyno-updater] atualizador indisponível (verifique a chave pública): {err}");
            if notify_if_current {
                notify_user(
                    app,
                    "Atualização",
                    "Não foi possível verificar atualizações agora.",
                );
            }
            return;
        }
    };

    let maybe_update = match updater.check().await {
        Ok(u) => u,
        Err(err) => {
            eprintln!("[cyno-updater] falha ao checar atualização: {err}");
            if notify_if_current {
                notify_user(
                    app,
                    "Atualização",
                    "Não foi possível consultar o servidor de atualizações.",
                );
            }
            return;
        }
    };

    let Some(update) = maybe_update else {
        if notify_if_current {
            notify_user(app, "Cyno Office", "Você já está na versão mais recente.");
        }
        return;
    };

    let version = update.version.clone();

    // Evita baixar novamente a mesma versão já guardada em memória.
    let already_ready = app
        .state::<AppState>()
        .pending_update
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|p| p.version == version))
        .unwrap_or(false);

    if already_ready {
        if notify_if_current {
            notify_user(
                app,
                "Atualização pronta",
                &format!("A versão v{version} já está baixada. Use 'Sair e atualizar' na bandeja."),
            );
        }
        return;
    }

    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(b) => b,
        Err(err) => {
            eprintln!("[cyno-updater] falha ao baixar v{version}: {err}");
            return;
        }
    };

    let state = app.state::<AppState>();
    let flag_path = pending_flag_path(&state.data_dir);
    let _ = fs::write(&flag_path, &version);

    if let Ok(mut guard) = state.pending_update.lock() {
        *guard = Some(PendingUpdate {
            version: version.clone(),
            update,
            bytes,
        });
    }

    if let Ok(guard) = state.tray_update_item.lock() {
        if let Some(item) = guard.as_ref() {
            let _ = item.set_text(format!("Sair e atualizar (v{version})"));
            let _ = item.set_enabled(true);
        }
    }

    notify_user(
        app,
        "Atualização pronta",
        &format!(
            "Versão v{version} baixada em segundo plano. Escolha 'Sair e atualizar' na bandeja quando terminar."
        ),
    );
}

/// No próximo início (antes de subir o servidor Node), aplica a atualização pendente se o usuário
/// saiu antes sem clicar em "Sair e atualizar". Devolve `true` se a instalação foi disparada.
pub async fn apply_pending_on_startup(app: &AppHandle) -> bool {
    let data_dir = app.state::<AppState>().data_dir.clone();
    let flag_path = pending_flag_path(&data_dir);
    if !flag_path.is_file() {
        return false;
    }

    // Remove o marcador antes de tentar para evitar loop se estiver offline ou falhar.
    let _ = fs::remove_file(&flag_path);

    let Ok(updater) = app.updater() else {
        return false;
    };
    let Ok(Some(update)) = updater.check().await else {
        return false;
    };
    let version = update.version.clone();
    let Ok(bytes) = update.download(|_, _| {}, || {}).await else {
        return false;
    };

    if let Err(err) = backup_data_dir(&data_dir, &version) {
        eprintln!("[cyno-updater] backup falhou antes da instalação no início: {err}");
        return false;
    }

    match update.install(bytes) {
        Ok(()) => true,
        Err(err) => {
            eprintln!("[cyno-updater] falha ao instalar v{version} no início: {err}");
            false
        }
    }
}

/// Para o servidor, faz backup dos dados e aplica a atualização já baixada.
pub async fn apply_pending_and_exit(app: AppHandle) {
    let (pending, data_dir) = {
        let state = app.state::<AppState>();
        let item = state
            .pending_update
            .lock()
            .ok()
            .and_then(|mut g| g.take());
        (item, state.data_dir.clone())
    };

    let Some(pending) = pending else {
        notify_user(
            &app,
            "Atualização",
            "Nenhuma atualização pronta para instalar.",
        );
        return;
    };

    let _ = fs::remove_file(pending_flag_path(&data_dir));

    // Encerra o servidor antes do backup para não copiar arquivos abertos no meio da escrita.
    {
        let state = app.state::<AppState>();
        server::stop_server(&state);
    }
    tokio::time::sleep(Duration::from_millis(400)).await;

    let version_for_backup = pending.version.clone();
    let dir_for_backup = data_dir.clone();
    let backup_result = tauri::async_runtime::spawn_blocking(move || {
        backup_data_dir(&dir_for_backup, &version_for_backup)
    })
    .await
    .unwrap_or_else(|e| Err(format!("falha na tarefa de backup: {e}")));

    match backup_result {
        Ok(dest) => {
            eprintln!("[cyno-updater] backup concluído em {}", dest.display());
        }
        Err(err) => {
            eprintln!("[cyno-updater] backup falhou; instalação cancelada por segurança: {err}");
            notify_user(
                &app,
                "Atualização cancelada",
                "Não foi possível fazer o backup dos dados antes de atualizar.",
            );
            app.exit(1);
            return;
        }
    }

    if let Err(err) = pending.update.install(pending.bytes) {
        eprintln!("[cyno-updater] erro ao instalar v{}: {err}", pending.version);
        notify_user(
            &app,
            "Erro ao atualizar",
            "Não foi possível aplicar a atualização. Seus dados continuam salvos em backup.",
        );
    }

    app.exit(0);
}

fn pending_flag_path(data_dir: &Path) -> PathBuf {
    data_dir
        .parent()
        .unwrap_or(data_dir)
        .join(PENDING_FLAG_NAME)
}

/// Copia recursivamente a pasta de dados para `<dados>/../backups/<versão>-<data>`.
pub fn backup_data_dir(data_dir: &Path, version: &str) -> Result<PathBuf, String> {
    let parent = data_dir.parent().unwrap_or(data_dir);
    let safe_version: String = version
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stamp = utc_timestamp_compact();
    let dest = parent
        .join("backups")
        .join(format!("{safe_version}-{stamp}"));

    if !data_dir.exists() {
        fs::create_dir_all(&dest).map_err(|e| format!("criar pasta de backup: {e}"))?;
        return Ok(dest);
    }

    copy_dir_recursive(data_dir, &dest)?;
    Ok(dest)
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("criar diretório {}: {e}", dst.display()))?;
    let entries = fs::read_dir(src).map_err(|e| format!("ler diretório {}: {e}", src.display()))?;

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                eprintln!("[cyno-updater] ignorando entrada ilegível no backup: {err}");
                continue;
            }
        };
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        // Evita seguir links simbólicos que possam criar ciclos no backup.
        if file_type.is_symlink() {
            continue;
        }
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if file_type.is_file() {
            fs::copy(&from, &to)
                .map_err(|e| format!("copiar {} -> {}: {e}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

/// Data/hora UTC compacta (`YYYYMMDD-HHMMSS`) sem depender de crates externos de calendário.
fn utc_timestamp_compact() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let hour = rem / 3_600;
    let minute = (rem % 3_600) / 60;
    let second = rem % 60;
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

/// Algoritmo de Howard Hinnant para converter dias desde 1970-01-01 em (ano, mês, dia).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m as u32, d as u32)
}

fn notify_user(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}
