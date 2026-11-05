fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "server_choices",
            "connect_server",
            "cancel_chooser",
            "remove_recent",
            "retry_connection",
            "cancel_connection",
            "show_connection",
        ]),
    ))
    .expect("failed to build native app metadata");
}
