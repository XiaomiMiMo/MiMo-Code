// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri_plugin_shell::ShellExt;

const DESKTOP_SECRET: &str = "mimocode-desktop-secret";

#[tauri::command]
fn mac_open_in_terminal(command: String, terminal: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let term_app = terminal.unwrap_or_else(|| "Terminal".to_string());
        let script = if term_app == "iTerm" {
            format!(
                "tell application \"iTerm\"\n  create window with default profile\n  tell current session of current window\n    write text \"{}\"\n  end tell\nend tell",
                command.replace('\\', "\\\\").replace('"', "\\\"")
            )
        } else {
            format!(
                "tell application \"Terminal\"\n  do script \"{}\"\n  activate\nend tell",
                command.replace('\\', "\\\\").replace('"', "\\\"")
            )
        };

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output()
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("mac_open_in_terminal is only available on macOS".into())
    }
}

#[tauri::command]
fn mac_capabilities() -> serde_json::Value {
    let is_mac = cfg!(target_os = "macos");
    serde_json::json!({
        "platform": if is_mac { "darwin" } else { std::env::consts::OS },
        "supports": {
            "keychain": is_mac,
            "notifications": true,
            "dockBadge": is_mac,
            "appleScript": is_mac,
            "universalClipboard": is_mac,
            "spotlight": is_mac
        }
    })
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            // 自动拉起 Sidecar 进程：opencode serve，并传递客户端桌面标识与密钥
            tauri::async_runtime::spawn(async move {
                match handle.shell().sidecar("opencode") {
                    Ok(sidecar) => {
                        let res = sidecar
                            .env("OPENCODE_CLIENT", "desktop")
                            .env("MIMOCODE_CLIENT", "desktop")
                            .env("OPENCODE_EXPERIMENTAL_FILEWATCHER", "true")
                            .env("OPENCODE_SERVER_USERNAME", "opencode")
                            .env("OPENCODE_SERVER_PASSWORD", DESKTOP_SECRET)
                            .env("MIMOCODE_SERVER_USERNAME", "opencode")
                            .env("MIMOCODE_SERVER_PASSWORD", DESKTOP_SECRET)
                            .args(["serve"])
                            .spawn();
                        if let Err(e) = res {
                            eprintln!("[Sidecar Error] Failed to spawn opencode sidecar: {:?}", e);
                        }
                    }
                    Err(e) => {
                        eprintln!("[Sidecar Error] Failed to create opencode sidecar command: {:?}", e);
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mac_open_in_terminal,
            mac_capabilities
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
