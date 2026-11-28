use std::borrow::Cow;
use std::path::MAIN_SEPARATOR_STR;

use garcon_contract::executor_path::ExecutorPath;

pub fn to_executor_path(native_path: &str, separator: Option<&str>) -> ExecutorPath {
    if separator.unwrap_or(MAIN_SEPARATOR_STR) == "\\" {
        native_path.replace('\\', "/")
    } else {
        native_path.into()
    }
}

pub fn to_native_path<'a>(executor_path: &'a str, separator: Option<&str>) -> Cow<'a, str> {
    if separator.unwrap_or(MAIN_SEPARATOR_STR) == "\\" {
        Cow::Owned(executor_path.replace('/', "\\"))
    } else {
        Cow::Borrowed(executor_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_windows_separators_or_leaves_a_posix_backslash_literal() {
        assert_eq!(to_executor_path(r"C:\dir\file", Some("\\")), "C:/dir/file");
        assert_eq!(to_native_path("C:/dir/file", Some("\\")), r"C:\dir\file");
        assert_eq!(to_executor_path(r"/dir/a\b", Some("/")), r"/dir/a\b");
        assert_eq!(to_native_path(r"/dir/a\b", Some("/")), r"/dir/a\b");
    }
}
