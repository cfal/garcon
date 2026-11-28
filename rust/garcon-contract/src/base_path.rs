//! Mount path validation and route prefix stripping.

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error(
    "Invalid base path: use an absolute path of unescaped letters, digits, dots, hyphens, underscores, or tildes, without empty or dot segments"
)]
pub struct InvalidBasePath;

pub fn parse_base_path(value: &str) -> Result<&str, InvalidBasePath> {
    if value.is_empty() || value == "/" {
        return Ok("");
    }
    let normalized = value.strip_suffix('/').unwrap_or(value);
    let Some(segments) = normalized.strip_prefix('/') else {
        return Err(InvalidBasePath);
    };
    if garcon_js::utf16::len(normalized) > 1024
        || normalized
            .bytes()
            .any(|b| !b.is_ascii_alphanumeric() && !b"._~/-".contains(&b))
        || segments
            .split('/')
            .any(|segment| matches!(segment, "" | "." | ".."))
    {
        return Err(InvalidBasePath);
    }
    Ok(normalized)
}

pub fn strip_base_path<'a>(pathname: &'a str, base_path: &str) -> Option<&'a str> {
    if base_path.is_empty() {
        return pathname.starts_with('/').then_some(pathname);
    }
    let suffix = pathname.strip_prefix(base_path)?;
    if suffix.is_empty() {
        Some("/")
    } else {
        suffix.starts_with('/').then_some(suffix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_mounts_and_rejects_ambiguous_mounts() {
        for (input, expected) in [
            ("", ""),
            ("/", ""),
            ("/garcon", "/garcon"),
            ("/tools/garcon/", "/tools/garcon"),
            ("/a_B-1.2~", "/a_B-1.2~"),
        ] {
            assert_eq!(parse_base_path(input), Ok(expected));
        }
        for input in [
            "relative",
            "//host",
            "/a//b",
            "/a//",
            "/.",
            "/a/../b",
            "/a/./b",
            "/a%2fb",
            "/a%20b",
            "/a?b",
            "/a#b",
            "/a\\b",
            "/a b",
            "/a\nb",
            "/a\n",
            "/a\r\n",
            "/a\t",
            "/<script>",
            "/:id",
            "/*",
            "/\u{1f680}",
        ] {
            assert_eq!(parse_base_path(input), Err(InvalidBasePath), "{input:?}");
        }
    }

    #[test]
    fn limits_length_after_removing_a_single_trailing_slash() {
        let longest = format!("/{}", "a".repeat(1023));
        assert_eq!(parse_base_path(&longest), Ok(longest.as_str()));
        assert_eq!(
            parse_base_path(&format!("{longest}/")),
            Ok(longest.as_str())
        );
        assert_eq!(
            parse_base_path(&format!("{longest}a/")),
            Err(InvalidBasePath)
        );
    }

    #[test]
    fn strips_only_complete_segments_and_preserves_route_escapes() {
        for (path, base, result) in [
            (
                "/tools/garcon/api/v1/files",
                "/tools/garcon",
                Some("/api/v1/files"),
            ),
            ("/tools/garcon", "/tools/garcon", Some("/")),
            ("/tools/garcon/", "/tools/garcon", Some("/")),
            ("/tools/garcon-other/api", "/tools/garcon", None),
            ("/api", "/tools/garcon", None),
            ("/tools/garcon/a%20b", "/tools/garcon", Some("/a%20b")),
            ("/api", "", Some("/api")),
            ("api", "", None),
        ] {
            assert_eq!(strip_base_path(path, base), result);
        }
    }
}
