pub fn default_user_shell() -> String {
    if cfg!(windows) {
        return "powershell.exe".into();
    }
    select_shell(std::env::var("GARCON_TERMINAL_SHELL").ok(), || {
        std::env::var("SHELL").ok()
    })
}

fn select_shell(
    override_shell: Option<String>,
    env_shell: impl FnOnce() -> Option<String>,
) -> String {
    override_shell
        .filter(|shell| !shell.is_empty())
        .or_else(|| env_shell().filter(|shell| !shell.is_empty()))
        .unwrap_or_else(|| "/bin/bash".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_the_override_then_the_user_shell_and_ignores_empty_values() {
        assert_eq!(
            select_shell(Some("/opt/shell".into()), || Some("/bin/sh".into())),
            "/opt/shell"
        );
        assert_eq!(
            select_shell(Some(String::new()), || Some("/bin/sh".into())),
            "/bin/sh"
        );
        assert_eq!(select_shell(None, || Some(String::new())), "/bin/bash");
        assert_eq!(select_shell(None, || None), "/bin/bash");
        assert_eq!(select_shell(Some(" ".into()), || None), " ");
    }
}
