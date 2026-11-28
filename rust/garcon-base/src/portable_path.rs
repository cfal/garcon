//! Canonical executor paths independent of the controller's platform.

use garcon_js::path::{posix, win32};

fn windows_path(value: &str) -> bool {
    value.starts_with("//")
        || matches!(value.as_bytes(), [letter, b':', b'/', ..] if letter.is_ascii_alphabetic())
}

pub fn is_canonical_executor_path(value: &str) -> bool {
    if value.contains('\0')
        || value
            .split('/')
            .any(|segment| matches!(segment, "." | ".."))
    {
        return false;
    }
    if windows_path(value) {
        !value.contains('\\')
            && win32::is_absolute(value)
            && (!value.ends_with('/') || win32::parse_root(value) == value)
            && win32::normalize(value).replace('\\', "/") == value
    } else {
        posix::is_absolute(value)
            && (!value.ends_with('/') || value == "/")
            && posix::normalize(value) == value
    }
}

/// Rejects a lone surrogate before applying the portable path rules.
pub fn is_canonical_executor_path_utf16(value: &[u16]) -> bool {
    String::from_utf16(value).is_ok_and(|value| is_canonical_executor_path(&value))
}

pub fn parent_executor_path(value: &str) -> String {
    if windows_path(value) {
        win32::dirname(value).replace('\\', "/")
    } else {
        posix::dirname(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_canonical_paths_and_preserves_their_flavor() {
        for (path, parent) in [
            ("/", "/"),
            ("/worker/project", "/worker"),
            ("C:/", "C:/"),
            ("C:/worker/project", "C:/worker"),
            ("//host/share/", "//host/share/"),
            ("//host/share/project", "//host/share/"),
            ("/worker/caf\u{e9}", "/worker"),
            ("/worker/literal\\name/file", "/worker/literal\\name"),
        ] {
            assert!(is_canonical_executor_path(path), "{path}");
            assert_eq!(parent_executor_path(path), parent);
        }
        for path in [
            "relative",
            "/worker/../project",
            "/worker/./project",
            "/worker//project",
            "/worker/project/",
            "C:/worker\\project",
            "C:/worker/",
            "//host",
            "//host/../project",
            "/worker/\0",
        ] {
            assert!(!is_canonical_executor_path(path), "{path}");
        }
        let mut unpaired: Vec<_> = "/worker/".encode_utf16().collect();
        unpaired.push(0xd800);
        assert!(!is_canonical_executor_path_utf16(&unpaired));
        assert!(is_canonical_executor_path("/worker/\u{fffd}"));
    }
}
