// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_shell::ShellExt;

const DESKTOP_SECRET: &str = "mimocode-desktop-secret";

// ── macOS Terminal Integration ──────────────────────────────────────────────

#[tauri::command]
fn mac_open_in_terminal(command: String, terminal: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let term_app = terminal.unwrap_or_else(|| "Terminal".to_string());
        let escaped = command.replace('\\', "\\\\").replace('"', "\\\"");
        let script = if term_app == "iTerm" {
            format!(
                "tell application \"iTerm\"\n  create window with default profile\n  tell current session of current window\n    write text \"{}\"\n  end tell\nend tell",
                escaped
            )
        } else {
            format!(
                "tell application \"Terminal\"\n  do script \"{}\"\n  activate\nend tell",
                escaped
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
        let _ = (command, terminal);
        Err("mac_open_in_terminal is only available on macOS".into())
    }
}

// ── macOS Capabilities ─────────────────────────────────────────────────────

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

// ── macOS Dock Badge ───────────────────────────────────────────────────────

#[tauri::command]
fn mac_set_dock_badge(text: Option<String>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let badge = text.as_deref().unwrap_or("");
        let script = format!(
            r#"tell application "System Events"
    set processList to name of every process
    if "MiMo-Code" is in processList then
        tell application "MiMo-Code"
            if "{}" is "" then
                set badge of dock tile to missing value
            else
                set badge of dock tile to "{}"
            end if
        end tell
    end if
end tell"#,
            badge, badge
        );
        let _ = Command::new("osascript").arg("-e").arg(&script).output();
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        Ok(())
    }
}

// ── macOS Keychain (via `security` CLI) ────────────────────────────────────

fn mac_keychain_set_impl(name: &str, value: &str) -> Result<(), String> {
    let service = format!("com.mimo-ai.desktop.{}", name);
    // Delete existing first, then add
    let _ = Command::new("security")
        .args([
            "delete-generic-password",
            "-s", &service,
            "-a", name,
        ])
        .output();
    let output = Command::new("security")
        .args([
            "add-generic-password",
            "-s", &service,
            "-a", name,
            "-w", value,
            "-U", // update if exists (though we already deleted)
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

fn mac_keychain_get_impl(name: &str) -> Result<Option<String>, String> {
    let service = format!("com.mimo-ai.desktop.{}", name);
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-s", &service,
            "-a", name,
            "-w",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        let s = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
        Ok(Some(s.trim_end_matches('\n').to_string()))
    } else {
        Ok(None)
    }
}

fn mac_keychain_delete_impl(name: &str) -> Result<(), String> {
    let service = format!("com.mimo-ai.desktop.{}", name);
    let output = Command::new("security")
        .args([
            "delete-generic-password",
            "-s", &service,
            "-a", name,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        // Not finding the item is not an error
        Ok(())
    }
}

#[tauri::command]
fn mac_keychain_set(name: String, value: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac_keychain_set_impl(&name, &value)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (name, value);
        Err("mac_keychain_set is only available on macOS".into())
    }
}

#[tauri::command]
fn mac_keychain_get(name: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        mac_keychain_get_impl(&name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = name;
        Err("mac_keychain_get is only available on macOS".into())
    }
}

#[tauri::command]
fn mac_keychain_delete(name: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        mac_keychain_delete_impl(&name)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = name;
        Err("mac_keychain_delete is only available on macOS".into())
    }
}

// ── Application Entry ──────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::default().build())
        .setup(|app| {
            // Build macOS menu
            #[cfg(target_os = "macos")]
            {
                let check_updates = MenuItemBuilder::with_id("check_updates", "检查更新...").build(app)?;
                let about = PredefinedMenuItem::about(app, Some("关于 MiMo-Code"), None::<tauri::menu::AboutMetadata>)?;

                let app_submenu = SubmenuBuilder::new(app, "MiMo-Code")
                    .item(&about)
                    .separator()
                    .item(&check_updates)
                    .separator()
                    .quit()
                    .build()?;

                let edit_submenu = SubmenuBuilder::new(app, "编辑")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                let window_submenu = SubmenuBuilder::new(app, "窗口")
                    .minimize()
                    .close_window()
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .item(&app_submenu)
                    .item(&edit_submenu)
                    .item(&window_submenu)
                    .build()?;

                app.set_menu(menu)?;
            }

            // Build tray icon — use trayTemplate.png (grayscale macOS template)
            let tray_img = image::load_from_memory(include_bytes!("../icons/trayTemplate.png"))
                .map(|img| img.into_rgba8())
                .ok();
            let tray_icon = tray_img
                .as_ref()
                .map(|img| tauri::image::Image::new_owned(img.to_vec(), img.width(), img.height()))
                .unwrap_or_else(|| app.default_window_icon().unwrap().clone());

            let tray_open = MenuItemBuilder::with_id("tray_open", "Open MiMo-Code").build(app)?;
            let tray_quit = MenuItemBuilder::with_id("tray_quit", "Quit").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .item(&tray_open)
                .separator()
                .item(&tray_quit)
                .build()?;

            TrayIconBuilder::new()
                .icon(tray_icon)
                .tooltip("MiMo-Code")
                .menu(&tray_menu)
                .on_menu_event(|app_handle, event| {
                    match event.id().as_ref() {
                        "tray_open" => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "tray_quit" => {
                            app_handle.exit(0);
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            // Auto-spawn sidecar: opencode serve
            let handle = app.handle().clone();
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
            mac_capabilities,
            mac_set_dock_badge,
            mac_keychain_set,
            mac_keychain_get,
            mac_keychain_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
