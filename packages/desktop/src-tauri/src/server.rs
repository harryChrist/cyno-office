use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::state::AppState;

pub const DEFAULT_WEB_PORT: u16 = 3067;
pub const DEFAULT_API_PORT: u16 = 3068;

/// Lê uma porta de variável de ambiente com valor padrão seguro.
pub fn env_port(key: &str, fallback: u16) -> u16 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .filter(|&p| p > 0)
        .unwrap_or(fallback)
}

/// Resolve a pasta de dados do Cyno:
/// 1) `DATA_DIR` do ambiente (se definida e não vazia);
/// 2) `%LOCALAPPDATA%\CynoOffice\data` no Windows;
/// 3) diretório local de dados do app fornecido pelo Tauri;
/// 4) fallback `./CynoOffice/data`.
pub fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(env_dir) = std::env::var("DATA_DIR") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty() {
            return ensure_dir(PathBuf::from(trimmed));
        }
    }

    #[cfg(target_os = "windows")]
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let trimmed = local_app_data.trim();
        if !trimmed.is_empty() {
            return ensure_dir(PathBuf::from(trimmed).join("CynoOffice").join("data"));
        }
    }

    if let Ok(base) = app.path().app_local_data_dir() {
        return ensure_dir(base.join("data"));
    }

    ensure_dir(PathBuf::from("CynoOffice").join("data"))
}

fn ensure_dir(path: PathBuf) -> PathBuf {
    if let Err(err) = std::fs::create_dir_all(&path) {
        eprintln!(
            "[cyno-desktop] aviso: não foi possível criar pasta de dados {}: {err}",
            path.display()
        );
    }
    path
}

/// Descobre o ponto de entrada do servidor Node:
/// `CYNO_SERVER_ENTRY` sobrescreve; caso contrário procura na pasta `resources/server/` do pacote.
pub fn resolve_server_entry(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("CYNO_SERVER_ENTRY") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }

    let resource_dir = app.path().resource_dir().ok()?;
    let candidates = [
        resource_dir.join("resources").join("server").join("entry.mjs"),
        resource_dir.join("resources").join("server").join("index.mjs"),
        resource_dir.join("resources").join("server").join("index.js"),
        resource_dir.join("server").join("entry.mjs"),
        resource_dir.join("server").join("index.mjs"),
        resource_dir.join("server").join("index.js"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Inicia o servidor Cyno usando o Node empacotado como sidecar (`binaries/node`).
pub fn start_server(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let entry = resolve_server_entry(app).ok_or_else(|| {
        "Ponto de entrada do servidor não encontrado (defina CYNO_SERVER_ENTRY ou empacote resources/server/entry.mjs)".to_string()
    })?;

    let mut cmd = app
        .shell()
        .sidecar("binaries/node")
        .map_err(|e| format!("sidecar binaries/node indisponível: {e}"))?
        .args([entry.to_string_lossy().as_ref()])
        .env("DATA_DIR", state.data_dir.to_string_lossy().as_ref())
        .env("PORT", state.api_port.to_string())
        .env("WEB_PORT", state.web_port.to_string())
        .env("HOST", "127.0.0.1")
        .env("WEB_HOST", "127.0.0.1")
        .env("CYNO_DESKTOP", "1");

    if let Some(parent) = entry.parent() {
        cmd = cmd.current_dir(parent);
    }

    let (mut rx, child) = cmd
        .spawn()
        .map_err(|e| format!("falha ao iniciar servidor Node: {e}"))?;

    if let Ok(mut guard) = state.sidecar.lock() {
        *guard = Some(child);
    }

    // Drena stdout/stderr do processo filho para evitar travamento de buffer no Windows.
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes);
                    eprintln!("[cyno-server] {}", line.trim_end());
                }
                CommandEvent::Error(err) => {
                    eprintln!("[cyno-server] erro: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!(
                        "[cyno-server] encerrado (code={:?}, signal={:?})",
                        payload.code, payload.signal
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Aguarda `GET /api/health` responder 200 OK antes de exibir a janela.
/// Testa primeiro a porta web (3067, que faz proxy de `/api/health` para a 3068);
/// assim garantimos que tanto a interface quanto a API estão de pé.
pub async fn wait_for_health(web_port: u16, api_port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let ready = tauri::async_runtime::spawn_blocking(move || {
            check_http_health(web_port) || (web_port != api_port && check_http_health(api_port))
        })
        .await
        .unwrap_or(false);

        if ready {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    false
}

fn check_http_health(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));

    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut buf = [0u8; 64];
    let Ok(n) = stream.read(&mut buf) else {
        return false;
    };
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// Encerra toda a árvore de processos do sidecar ao sair do aplicativo.
pub fn stop_server(state: &AppState) {
    let child = state.sidecar.lock().ok().and_then(|mut guard| guard.take());
    let Some(child) = child else {
        return;
    };

    let pid = child.pid();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW evita piscar uma janela de prompt ao rodar taskkill.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
    }

    let _ = child.kill();
}
