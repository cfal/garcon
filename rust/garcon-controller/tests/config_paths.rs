use garcon_js::path::win32;

#[test]
fn windows_config_paths_resolve_drive_relative_and_root_relative_inputs() {
    let cwd = r"C:\work";
    assert_eq!(win32::resolve(cwd, &[r"C:sub"]), r"C:\work\sub");
    assert_eq!(win32::resolve(cwd, &[r"C:..\projects"]), r"C:\projects");
    assert_eq!(win32::resolve(cwd, &[r"\assets"]), r"C:\assets");
    #[cfg(not(windows))]
    assert_eq!(win32::resolve(cwd, &[r"D:sub"]), r"D:\sub");
}
