//! Ports `common/executor-path.ts`.

/// An executor path. Executor paths use forward slashes; POSIX filename
/// backslashes remain literal.
pub type ExecutorPath = String;

/// Whether `candidate` is `root` itself or lies below it.
pub fn is_within_executor_path(root: &str, candidate: &str) -> bool {
    if candidate == root {
        return true;
    }
    let below_root = if root.ends_with('/') {
        root.to_owned()
    } else {
        format!("{root}/")
    };
    candidate.starts_with(&below_root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_root_and_what_lies_below_it() {
        assert!(is_within_executor_path("/work", "/work"));
        assert!(is_within_executor_path("/work", "/work/src/a.ts"));
        assert!(is_within_executor_path("/work/", "/work/src"));
        assert!(is_within_executor_path("/", "/work/src"));
    }

    #[test]
    fn rejects_a_sibling_or_a_longer_root() {
        assert!(!is_within_executor_path("/work", "/worker"));
        assert!(!is_within_executor_path("/work", "/other/work"));
        assert!(!is_within_executor_path("/work/src", "/work"));
        // A backslash is an ordinary character, not a separator.
        assert!(is_within_executor_path("/work", "/work/src\\a"));
        assert!(!is_within_executor_path("/work", "/work\\src"));
    }
}
