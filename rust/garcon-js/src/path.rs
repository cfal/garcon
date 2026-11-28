//! Node's `path` functions, which normalize `.` and `..` lexically where
//! `std::path` keeps them. `posix` is `path` on Linux; `win32` is the flavor
//! the ported code selects for Windows-style executor paths on any platform.

/// Resolves `.` and `..` elements in a path with directory names. Mirrors
/// Node's `normalizeString`.
fn normalize_string(
    path: &str,
    allow_above_root: bool,
    separator: char,
    is_separator: fn(u8) -> bool,
) -> String {
    let bytes = path.as_bytes();
    let mut result = String::new();
    let mut last_segment_length: usize = 0;
    let mut last_slash: isize = -1;
    let mut dots: isize = 0;
    let mut code: u8 = 0;
    let mut index = 0;
    while index <= bytes.len() {
        if index < bytes.len() {
            code = bytes[index];
        } else if is_separator(code) {
            break;
        } else {
            code = b'/';
        }

        if is_separator(code) {
            if last_slash == index as isize - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let done = result.as_bytes();
                if done.len() < 2
                    || last_segment_length != 2
                    || done[done.len() - 1] != b'.'
                    || done[done.len() - 2] != b'.'
                {
                    if done.len() > 2 {
                        match result.rfind(separator) {
                            None => {
                                result.clear();
                                last_segment_length = 0;
                            }
                            Some(last_slash_index) => {
                                result.truncate(last_slash_index);
                                let previous = result.rfind(separator).map_or(-1, |at| at as isize);
                                last_segment_length =
                                    (result.len() as isize - 1 - previous) as usize;
                            }
                        }
                        last_slash = index as isize;
                        dots = 0;
                        index += 1;
                        continue;
                    } else if !result.is_empty() {
                        result.clear();
                        last_segment_length = 0;
                        last_slash = index as isize;
                        dots = 0;
                        index += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if !result.is_empty() {
                        result.push(separator);
                        result.push_str("..");
                    } else {
                        result.push_str("..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let segment = &path[(last_slash + 1) as usize..index];
                if !result.is_empty() {
                    result.push(separator);
                }
                result.push_str(segment);
                last_segment_length = segment.len();
            }
            last_slash = index as isize;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        index += 1;
    }
    result
}

fn is_posix_separator(code: u8) -> bool {
    code == b'/'
}

fn is_windows_separator(code: u8) -> bool {
    code == b'/' || code == b'\\'
}

fn is_windows_device_root(code: u8) -> bool {
    code.is_ascii_alphabetic()
}

/// `path.posix`, which is `path` on Linux.
pub mod posix {
    use super::{is_posix_separator, normalize_string};

    /// `path.sep`.
    pub const SEP: &str = "/";

    /// `path.resolve(...args)`. Node reads `process.cwd()` when no argument is
    /// absolute; the caller passes that directory as `cwd`.
    pub fn resolve(cwd: &str, args: &[&str]) -> String {
        let mut resolved_path = String::new();
        let mut resolved_absolute = false;
        for path in args.iter().rev() {
            if path.is_empty() {
                continue;
            }
            resolved_path = format!("{path}/{resolved_path}");
            resolved_absolute = path.as_bytes()[0] == b'/';
            if resolved_absolute {
                break;
            }
        }
        if !resolved_absolute {
            resolved_path = format!("{cwd}/{resolved_path}");
            resolved_absolute = cwd.as_bytes().first() == Some(&b'/');
        }
        let resolved_path =
            normalize_string(&resolved_path, !resolved_absolute, '/', is_posix_separator);
        if resolved_absolute {
            format!("/{resolved_path}")
        } else if resolved_path.is_empty() {
            ".".to_owned()
        } else {
            resolved_path
        }
    }

    /// `path.normalize(path)`.
    pub fn normalize(path: &str) -> String {
        if path.is_empty() {
            return ".".to_owned();
        }
        let bytes = path.as_bytes();
        let is_absolute = bytes[0] == b'/';
        let trailing_separator = bytes[bytes.len() - 1] == b'/';
        let mut normalized = normalize_string(path, !is_absolute, '/', is_posix_separator);
        if normalized.is_empty() {
            return match (is_absolute, trailing_separator) {
                (true, _) => "/".to_owned(),
                (false, true) => "./".to_owned(),
                (false, false) => ".".to_owned(),
            };
        }
        if trailing_separator {
            normalized.push('/');
        }
        if is_absolute {
            format!("/{normalized}")
        } else {
            normalized
        }
    }

    /// `path.isAbsolute(path)`.
    pub fn is_absolute(path: &str) -> bool {
        path.as_bytes().first() == Some(&b'/')
    }

    /// `path.join(...args)`.
    pub fn join(args: &[&str]) -> String {
        let parts: Vec<&str> = args
            .iter()
            .copied()
            .filter(|part| !part.is_empty())
            .collect();
        if parts.is_empty() {
            return ".".to_owned();
        }
        normalize(&parts.join("/"))
    }

    /// `path.relative(from, to)`. As `resolve`, it reads `process.cwd()` for a
    /// relative argument; the caller passes that directory as `cwd`.
    pub fn relative(cwd: &str, from: &str, to: &str) -> String {
        if from == to {
            return String::new();
        }
        let from = resolve(cwd, &[from]);
        let to = resolve(cwd, &[to]);
        if from == to {
            return String::new();
        }
        let from_bytes = from.as_bytes();
        let to_bytes = to.as_bytes();
        let from_start = 1;
        let from_end = from_bytes.len();
        let from_len = from_end - from_start;
        let to_start = 1;
        let to_len = to_bytes.len() - to_start;

        let length = from_len.min(to_len);
        let mut last_common_sep: Option<usize> = None;
        let mut index = 0;
        while index < length {
            let from_code = from_bytes[from_start + index];
            if from_code != to_bytes[to_start + index] {
                break;
            } else if from_code == b'/' {
                last_common_sep = Some(index);
            }
            index += 1;
        }
        if index == length {
            if to_len > length {
                if to_bytes[to_start + index] == b'/' {
                    // `from` is the exact base path of `to`.
                    return to[to_start + index + 1..].to_owned();
                }
                if index == 0 {
                    // `from` is the root.
                    return to[to_start + index..].to_owned();
                }
            } else if from_len > length {
                if from_bytes[from_start + index] == b'/' {
                    // `to` is the exact base path of `from`.
                    last_common_sep = Some(index);
                } else if index == 0 {
                    // `to` is the root.
                    last_common_sep = Some(0);
                }
            }
        }
        let last_common_sep = last_common_sep.map_or(-1, |at| at as isize);
        let mut out = String::new();
        for at in from_start as isize + last_common_sep + 1..=from_end as isize {
            if at == from_end as isize || from_bytes[at as usize] == b'/' {
                if out.is_empty() {
                    out.push_str("..");
                } else {
                    out.push_str("/..");
                }
            }
        }
        let rest = to_start as isize + last_common_sep;
        format!("{out}{}", &to[rest as usize..])
    }

    /// `path.dirname(path)`.
    pub fn dirname(path: &str) -> String {
        if path.is_empty() {
            return ".".to_owned();
        }
        let bytes = path.as_bytes();
        let has_root = bytes[0] == b'/';
        let mut end: Option<usize> = None;
        let mut matched_slash = true;
        for at in (1..bytes.len()).rev() {
            if bytes[at] == b'/' {
                if !matched_slash {
                    end = Some(at);
                    break;
                }
            } else {
                matched_slash = false;
            }
        }
        match end {
            None => {
                if has_root {
                    "/".to_owned()
                } else {
                    ".".to_owned()
                }
            }
            Some(end) => {
                if has_root && end == 1 {
                    "//".to_owned()
                } else {
                    path[..end].to_owned()
                }
            }
        }
    }

    /// `path.basename(path)`.
    pub fn basename(path: &str) -> String {
        let bytes = path.as_bytes();
        let mut start = 0;
        let mut end: Option<usize> = None;
        let mut matched_slash = true;
        for at in (0..bytes.len()).rev() {
            if bytes[at] == b'/' {
                if !matched_slash {
                    start = at + 1;
                    break;
                }
            } else if end.is_none() {
                matched_slash = false;
                end = Some(at + 1);
            }
        }
        match end {
            None => String::new(),
            Some(end) => path[start..end].to_owned(),
        }
    }
}

/// `path.win32`: Windows path rules, applied on any platform.
pub mod win32 {
    use super::{is_windows_device_root, is_windows_separator, normalize_string};

    /// `path.win32.sep`.
    pub const SEP: &str = "\\";

    /// `path.win32.resolve(...paths)`, with the current directory supplied.
    pub fn resolve(cwd: &str, args: &[&str]) -> String {
        let mut device = String::new();
        let mut absolute = false;
        let mut tail = String::new();
        for path in args.iter().rev().copied() {
            if add_resolve_part(path, &mut device, &mut absolute, &mut tail) {
                break;
            }
        }
        if !absolute || device.is_empty() {
            let (cwd_device, _, _) = root_parts(cwd);
            if !absolute
                && !device.is_empty()
                && !cwd_device.is_empty()
                && !device.eq_ignore_ascii_case(&cwd_device)
            {
                let drive_cwd =
                    drive_current_directory(&device).unwrap_or_else(|| format!("{device}\\"));
                add_resolve_part(&drive_cwd, &mut device, &mut absolute, &mut tail);
            } else {
                add_resolve_part(cwd, &mut device, &mut absolute, &mut tail);
            }
        }
        let tail = normalize_string(&tail, !absolute, '\\', is_windows_separator);
        if absolute {
            format!("{device}\\{tail}")
        } else if device.is_empty() && tail.is_empty() {
            ".".to_owned()
        } else {
            format!("{device}{tail}")
        }
    }

    fn add_resolve_part(
        path: &str,
        device: &mut String,
        absolute: &mut bool,
        tail: &mut String,
    ) -> bool {
        let (found, root_end, is_absolute) = root_parts(path);
        if !found.is_empty() {
            if device.is_empty() {
                *device = found;
            } else if !device.eq_ignore_ascii_case(&found) {
                return false;
            }
        }
        if !*absolute {
            *tail = format!("{}\\{tail}", &path[root_end..]);
            *absolute = is_absolute;
        }
        *absolute && !device.is_empty()
    }

    fn root_parts(path: &str) -> (String, usize, bool) {
        let bytes = path.as_bytes();
        if bytes.len() >= 2
            && is_windows_separator(bytes[0])
            && is_windows_separator(bytes[1])
            && let Some((server, start, end)) = match_unc(bytes, 2)
        {
            let end = end.unwrap_or(bytes.len());
            return (format!("\\\\{server}\\{}", &path[start..end]), end, true);
        }
        let root = parse_root(path);
        if bytes.len() >= 2 && is_windows_device_root(bytes[0]) && bytes[1] == b':' {
            return (path[..2].to_owned(), root.len(), root.len() > 2);
        }
        (String::new(), root.len(), !root.is_empty())
    }

    #[cfg(windows)]
    fn drive_current_directory(device: &str) -> Option<String> {
        let cwd = std::env::var(format!("={device}")).ok()?;
        let (found, _, absolute) = root_parts(&cwd);
        (absolute && found.eq_ignore_ascii_case(device)).then_some(cwd)
    }

    #[cfg(not(windows))]
    fn drive_current_directory(_device: &str) -> Option<String> {
        None
    }

    /// `path.win32.join(...paths)`.
    pub fn join(args: &[&str]) -> String {
        let mut parts = args.iter().copied().filter(|part| !part.is_empty());
        let Some(first) = parts.next() else {
            return ".".into();
        };
        let allows_unc = first.as_bytes().get(..3).is_some_and(|prefix| {
            is_windows_separator(prefix[0])
                && is_windows_separator(prefix[1])
                && !is_windows_separator(prefix[2])
        });
        let mut joined = first.to_owned();
        for part in parts {
            joined.push('\\');
            joined.push_str(part);
        }
        if !allows_unc {
            let tail = joined.trim_start_matches(['/', '\\']);
            if joined.len() - tail.len() > 1 {
                return normalize(&format!("\\{tail}"));
            }
        }
        normalize(&joined)
    }

    /// `path.win32.relative(from, to)`, with the current directory supplied.
    pub fn relative(cwd: &str, from: &str, to: &str) -> String {
        let from = resolve(cwd, &[from]);
        let to = resolve(cwd, &[to]);
        let mut source = from.split('\\').filter(|part| !part.is_empty()).peekable();
        let mut target = to.split('\\').filter(|part| !part.is_empty()).peekable();
        if source
            .peek()
            .zip(target.peek())
            .is_some_and(|(a, b)| !a.eq_ignore_ascii_case(b))
        {
            return to;
        }
        while source
            .peek()
            .zip(target.peek())
            .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
        {
            source.next();
            target.next();
        }
        source
            .map(|_| "..")
            .chain(target)
            .collect::<Vec<_>>()
            .join(SEP)
    }

    /// `path.win32.basename(path)`, without an optional suffix.
    pub fn basename(path: &str) -> String {
        let bytes = path.as_bytes();
        let tail = if bytes.len() >= 2 && is_windows_device_root(bytes[0]) && bytes[1] == b':' {
            &path[2..]
        } else {
            path
        };
        tail.trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .into()
    }

    /// `path.win32.isAbsolute(path)`.
    pub fn is_absolute(path: &str) -> bool {
        let bytes = path.as_bytes();
        match bytes.first() {
            None => false,
            Some(&code) => {
                is_windows_separator(code)
                    || (bytes.len() > 2
                        && is_windows_device_root(code)
                        && bytes[1] == b':'
                        && is_windows_separator(bytes[2]))
            }
        }
    }

    /// `path.win32.normalize(path)`.
    pub fn normalize(path: &str) -> String {
        let bytes = path.as_bytes();
        let len = bytes.len();
        if len == 0 {
            return ".".to_owned();
        }
        let code = bytes[0];
        if len == 1 {
            return if code == b'/' {
                "\\".to_owned()
            } else {
                path.to_owned()
            };
        }
        let mut root_end = 0;
        let mut device: Option<String> = None;
        let mut is_absolute = false;
        if is_windows_separator(code) {
            // A leading separator makes the path absolute, as a UNC root or otherwise.
            is_absolute = true;
            if is_windows_separator(bytes[1]) {
                if let Some(unc) = match_unc(bytes, 2) {
                    let (first_part, last, rest) = unc;
                    if rest.is_none() {
                        // A UNC root only.
                        return format!("\\\\{first_part}\\{}\\", &path[last..]);
                    }
                    if let Some(j) = rest {
                        device = Some(format!("\\\\{first_part}\\{}", &path[last..j]));
                        root_end = j;
                    }
                }
            } else {
                root_end = 1;
            }
        } else if is_windows_device_root(code) && bytes[1] == b':' {
            device = Some(path[..2].to_owned());
            root_end = 2;
            if len > 2 && is_windows_separator(bytes[2]) {
                is_absolute = true;
                root_end = 3;
            }
        }

        let mut tail = if root_end < len {
            normalize_string(&path[root_end..], !is_absolute, '\\', is_windows_separator)
        } else {
            String::new()
        };
        if tail.is_empty() && !is_absolute {
            tail.push('.');
        }
        if !tail.is_empty() && is_windows_separator(bytes[len - 1]) {
            tail.push('\\');
        }
        match device {
            None => {
                if is_absolute {
                    format!("\\{tail}")
                } else {
                    tail
                }
            }
            Some(device) => {
                if is_absolute {
                    format!("{device}\\{tail}")
                } else {
                    format!("{device}{tail}")
                }
            }
        }
    }

    /// Matches a UNC root that starts at `start`: two separators, a server,
    /// separators, and a share. Returns the server, where the share begins,
    /// and where the share ends when anything follows it.
    fn match_unc(bytes: &[u8], start: usize) -> Option<(&str, usize, Option<usize>)> {
        let len = bytes.len();
        // The server runs to the first separator after `start`.
        let server_end = (start..len).find(|at| is_windows_separator(bytes[*at]));
        let server_end = match server_end {
            Some(end) if end > start => end,
            _ => return None,
        };
        let first_part = std::str::from_utf8(&bytes[start..server_end]).ok()?;
        // The share starts after the separators that follow and runs to the
        // next separator, when there is one.
        let separators_end = (server_end..len).find(|at| !is_windows_separator(bytes[*at]))?;
        let share_end = (separators_end..len).find(|at| is_windows_separator(bytes[*at]));
        if separators_end == share_end.unwrap_or(len) {
            return None;
        }
        Some((first_part, separators_end, share_end))
    }

    /// `path.win32.dirname(path)`.
    pub fn dirname(path: &str) -> String {
        let bytes = path.as_bytes();
        let len = bytes.len();
        if len == 0 {
            return ".".to_owned();
        }
        let code = bytes[0];
        if len == 1 {
            return if is_windows_separator(code) {
                path.to_owned()
            } else {
                ".".to_owned()
            };
        }
        let mut root_end: Option<usize> = None;
        let offset: usize;
        if is_windows_separator(code) {
            let mut at = 1;
            if is_windows_separator(bytes[1]) {
                match match_unc(bytes, 2) {
                    // A UNC root only.
                    Some((_, _, None)) => return path.to_owned(),
                    // The separator after the UNC root is kept in the root.
                    Some((_, _, Some(end))) => at = end + 1,
                    None => {}
                }
            }
            root_end = Some(at);
            offset = at;
        } else if is_windows_device_root(code) && bytes[1] == b':' {
            let end = if len > 2 && is_windows_separator(bytes[2]) {
                3
            } else {
                2
            };
            root_end = Some(end);
            offset = end;
        } else {
            offset = 0;
        }

        let mut end: Option<usize> = None;
        let mut matched_slash = true;
        for at in (offset..len).rev() {
            if is_windows_separator(bytes[at]) {
                if !matched_slash {
                    end = Some(at);
                    break;
                }
            } else {
                matched_slash = false;
            }
        }
        let end = end.or(root_end);
        match end {
            None => ".".to_owned(),
            Some(end) => path[..end].to_owned(),
        }
    }

    /// The `root` of `path.win32.parse(path)`.
    pub fn parse_root(path: &str) -> &str {
        let bytes = path.as_bytes();
        let len = bytes.len();
        if len == 0 {
            return "";
        }
        let code = bytes[0];
        if len == 1 {
            return if is_windows_separator(code) { path } else { "" };
        }
        let mut root_end = 0;
        if is_windows_separator(code) {
            root_end = 1;
            if is_windows_separator(bytes[1])
                && let Some((_, _, share_end)) = match_unc(bytes, 2)
            {
                match share_end {
                    // A UNC root only.
                    None => root_end = len,
                    // The separator after the UNC root is part of the root.
                    Some(end) => root_end = end + 1,
                }
            }
        } else if is_windows_device_root(code) && bytes[1] == b':' {
            if len <= 2 {
                return path;
            }
            root_end = 2;
            if is_windows_separator(bytes[2]) {
                if len == 3 {
                    return path;
                }
                root_end = 3;
            }
        }
        &path[..root_end]
    }
}

#[cfg(not(windows))]
pub use posix as native;
#[cfg(windows)]
pub use win32 as native;

#[cfg(test)]
mod tests {
    use super::posix;
    use super::win32;

    #[test]
    fn resolves_against_the_working_directory() {
        assert_eq!(posix::resolve("/home/user", &["/a", "b"]), "/a/b");
        assert_eq!(posix::resolve("/home/user", &["/a", "", "/b"]), "/b");
        assert_eq!(posix::resolve("/home/user", &["a", "../b"]), "/home/user/b");
        assert_eq!(posix::resolve("/home/user", &["a", "../../.."]), "/");
        assert_eq!(posix::resolve("/home/user", &["", ""]), "/home/user");
        assert_eq!(posix::resolve("/home/user", &[]), "/home/user");
        assert_eq!(posix::resolve("/home/user", &["../../x"]), "/x");
    }

    #[test]
    fn normalizes_dots_and_separators() {
        for (path, expected) in [
            ("", "."),
            ("/", "/"),
            ("//", "/"),
            ("a//b/./c/../d/", "a/b/d/"),
            ("../a", "../a"),
            ("/../a", "/a"),
            ("a/..", "."),
            ("a/../..", ".."),
            ("a/...", "a/..."),
            ("a/..b", "a/..b"),
            ("..a", "..a"),
            ("./", "./"),
            (".", "."),
            ("../", "../"),
            ("/a/..", "/"),
            ("a/b/c/../../..", "."),
            ("/..", "/"),
        ] {
            assert_eq!(posix::normalize(path), expected, "{path:?}");
        }
    }

    #[test]
    fn joins_without_a_working_directory() {
        assert_eq!(posix::join(&["/a", "b"]), "/a/b");
        assert_eq!(posix::join(&["/a", "", "b/"]), "/a/b/");
        assert_eq!(posix::join(&["a", "../b"]), "b");
        assert_eq!(posix::join(&[]), ".");
        assert_eq!(posix::join(&["", ""]), ".");
    }

    #[test]
    fn makes_a_destination_relative_to_a_base() {
        for (from, to, expected) in [
            ("/a/b", "/a/b", ""),
            ("/a/b", "/a/b/c", "c"),
            ("/a/b/c", "/a/b", ".."),
            ("/a/b/c", "/a/x", "../../x"),
            ("/a/b/c", "/a/x/y", "../../x/y"),
            ("/", "/a", "a"),
            ("/a", "/", ".."),
            ("/a/b", "/a", ".."),
            ("/a/b/", "/a/b/c", "c"),
            ("/x/y", "/a/b", "../../a/b"),
            ("/a", "/ab", "../ab"),
        ] {
            assert_eq!(
                posix::relative("/home/user", from, to),
                expected,
                "{from} -> {to}"
            );
        }
    }

    #[test]
    fn splits_directory_and_file_name() {
        for (path, dir, base) in [
            ("", ".", ""),
            ("/", "/", ""),
            ("//", "/", ""),
            ("//a", "//", "a"),
            ("//host/share/project", "//host/share", "project"),
            ("/a/b", "/a", "b"),
            ("/a", "/", "a"),
            ("a/b/", "a", "b"),
            ("a/b//", "a", "b"),
            ("a/b", "a", "b"),
            ("a", ".", "a"),
            (".", ".", "."),
            ("..", ".", ".."),
            ("a//b", "a/", "b"),
        ] {
            assert_eq!(posix::dirname(path), dir, "dirname({path:?})");
            assert_eq!(posix::basename(path), base, "basename({path:?})");
        }
        assert!(posix::is_absolute("/a"));
        assert!(!posix::is_absolute("a/b"));
    }

    #[test]
    fn applies_windows_rules_to_executor_paths() {
        for (value, absolute) in [
            ("C:/worker/project", true),
            ("C:\\worker", true),
            ("C:", false),
            ("C:worker", false),
            ("//host/share", true),
            ("/worker", true),
            ("relative", false),
            ("", false),
        ] {
            assert_eq!(win32::is_absolute(value), absolute, "{value:?}");
        }
        for (value, expected) in [
            ("C:/worker/project", "C:\\worker\\project"),
            ("C:/worker/../project", "C:\\project"),
            ("C:/worker//project/", "C:\\worker\\project\\"),
            ("//host/share/project", "\\\\host\\share\\project"),
            ("//host/share", "\\\\host\\share\\"),
            ("//host", "\\host"),
            ("//host/", "\\host\\"),
            ("C:", "C:."),
            ("C:/", "C:\\"),
            ("C:worker", "C:worker"),
            ("worker/../project", "project"),
            ("", "."),
            ("/", "\\"),
            ("//", "\\"),
            ("/worker/project", "\\worker\\project"),
            ("x/", "x\\"),
        ] {
            assert_eq!(win32::normalize(value), expected, "{value:?}");
        }
        for (value, expected) in [
            ("C:/worker/project", "C:/worker"),
            ("C:/worker", "C:/"),
            ("C:/worker/", "C:/"),
            ("C:worker", "C:"),
            ("C:", "C:"),
            ("/", "/"),
            ("//host/share/project", "//host/share/"),
            ("//host/share/", "//host/share/"),
            ("//host/share", "//host/share"),
            ("//host", "/"),
            ("//a//b//c", "//a//b/"),
            ("C:/a/../b", "C:/a/.."),
            ("worker", "."),
            ("", "."),
        ] {
            assert_eq!(win32::dirname(value), expected, "{value:?}");
        }
        for (value, expected) in [
            ("C:/worker/project", "C:/"),
            ("C:/", "C:/"),
            ("C:worker", "C:"),
            ("C:", "C:"),
            ("/", "/"),
            ("//host/share/project", "//host/share/"),
            ("//host/share", "//host/share"),
            ("//host", "/"),
            ("//a//b//c", "//a//b/"),
            ("/worker", "/"),
            ("worker", ""),
            ("", ""),
        ] {
            assert_eq!(win32::parse_root(value), expected, "{value:?}");
        }
    }
}
