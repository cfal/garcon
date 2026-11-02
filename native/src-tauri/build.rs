fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["saved_server", "connect_server"]),
    ))
    .expect("failed to build native app metadata");
}
