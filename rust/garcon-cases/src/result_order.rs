use std::collections::HashSet;

const ROOT: &str = "$.result";

/// A caller-owned result subtree whose keys may come in different orders.
/// Its values and array order are still compared normally.
#[derive(Debug, Clone, Copy)]
pub struct ResultOrderException<'a> {
    pub function: &'a str,
    /// Starts with `$.result`. `[*]` matches any array index.
    pub path: &'a str,
    pub reason: &'a str,
}

pub(crate) struct OrderExceptions<'a> {
    entries: &'a [ResultOrderException<'a>],
    matches: Vec<usize>,
}

impl<'a> OrderExceptions<'a> {
    pub(crate) fn new(entries: &'a [ResultOrderException<'a>]) -> Self {
        let mut seen = HashSet::new();
        for entry in entries {
            assert!(
                !entry.function.trim().is_empty() && !entry.reason.trim().is_empty(),
                "result key-order exceptions need a function and a reason"
            );
            assert!(
                entry
                    .path
                    .strip_prefix(ROOT)
                    .is_some_and(|tail| { tail.is_empty() || tail.starts_with(['.', '[']) }),
                "result key-order exception path must start with {ROOT}: {}",
                entry.path
            );
            assert!(
                seen.insert((entry.function, entry.path)),
                "duplicate result key-order exception for {} at {}",
                entry.function,
                entry.path
            );
        }
        Self {
            entries,
            matches: vec![0; entries.len()],
        }
    }

    pub(crate) fn visit(&mut self, function: &str, result_path: &str) -> bool {
        let tail = result_path.strip_prefix('$').unwrap_or(result_path);
        let mut ignored = false;
        for (entry, matches) in self.entries.iter().zip(&mut self.matches) {
            if entry.function == function && matches_path(&entry.path[ROOT.len()..], tail) {
                *matches += 1;
                ignored = true;
            }
        }
        ignored
    }

    pub(crate) fn report(&self) -> Vec<String> {
        let mut unused = Vec::new();
        for (entry, &matches) in self.entries.iter().zip(&self.matches) {
            if matches == 0 {
                unused.push(format!(
                    "{} at {} ({})",
                    entry.function, entry.path, entry.reason
                ));
            } else {
                println!(
                    "  KEY ORDER EXCEPTION {} at {}: {matches} result subtrees ({})",
                    entry.function, entry.path, entry.reason
                );
            }
        }
        unused
    }
}

fn array_wildcard(path: &str) -> Option<usize> {
    let mut quoted = false;
    let mut escaped = false;
    for (index, byte) in path.bytes().enumerate() {
        if escaped {
            escaped = false;
        } else if byte == b'\\' && quoted {
            escaped = true;
        } else if byte == b'"' {
            quoted = !quoted;
        } else if !quoted && byte == b'[' && path[index..].starts_with("[*]") {
            return Some(index);
        }
    }
    None
}

fn matches_path(mut pattern: &str, mut path: &str) -> bool {
    while let Some(wildcard) = array_wildcard(pattern) {
        let Some((index, rest)) = path
            .strip_prefix(&pattern[..wildcard])
            .and_then(|path| path.strip_prefix('['))
            .and_then(|path| path.split_once(']'))
        else {
            return false;
        };
        if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        path = rest;
        pattern = &pattern[wildcard + "[*]".len()..];
    }
    pattern == path
}

#[cfg(test)]
mod tests {
    use super::matches_path;

    #[test]
    fn paths_match_array_indices_but_not_brackets_in_a_field() {
        assert!(matches_path(
            ".items[*][0].meta[*]",
            ".items[2][0].meta[12]"
        ));
        assert!(!matches_path(
            ".items[*][0].meta[*]",
            ".items[2][1].meta[12]"
        ));
        assert!(!matches_path(".items[*]", r#".items["0"]"#));
        assert!(!matches_path(r#".items["x[*]"]"#, r#".items["x[2]"]"#));
        assert!(matches_path(r#".items["x[*]"]"#, r#".items["x[*]"]"#));
        assert!(!matches_path(".items[*]", ".items[0].nested"));
    }
}
