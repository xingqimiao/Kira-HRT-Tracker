#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_os::init())
    .plugin(tauri_plugin_secure_storage::init())
    .plugin(tauri_plugin_notifications::init())
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
