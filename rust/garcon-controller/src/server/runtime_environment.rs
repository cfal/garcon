/// Sets the CLI discovery context inherited by controller children.
///
/// # Safety
/// No other thread may be running or accessing the process environment.
pub(super) unsafe fn install(config_dir: &str) {
    // SAFETY: the native launcher installs this before starting its runtime.
    unsafe {
        for key in [
            "GARCON_CLI_RUNTIME",
            "GARCON_WORKSPACE",
            "GARCON_WORKSPACE_DIR",
        ] {
            std::env::remove_var(key);
        }
        std::env::set_var("GARCON_CONFIG_DIR", config_dir);
        std::env::set_var("GARCON_RUNTIME", "controller");
    }
}
