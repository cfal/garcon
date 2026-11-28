//! `which` against Bun 1.4.3, the runtime of the original, on the PATH
//! layouts `tests/oracles/which.ts` generates: the oracle runs every case in
//! its own Bun process and prints the answer Bun gave. The layouts are
//! POSIX, so this test exists only on Unix.

#![cfg(unix)]

use std::ffi::OsStr;
use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use garcon_agents_common::which::{which, which_in};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    label: String,
    name: String,
    path: Option<String>,
    cwd: String,
    // A directory the case holds at mode 0000 while it runs.
    #[serde(default)]
    hold_directory: Option<String>,
    expected: Option<String>,
}

#[derive(Deserialize)]
struct Reply {
    cases: Vec<Case>,
}

// Restores the directory's mode even when the case's assertion fails.
struct Unsearchable<'a>(&'a Path);

impl<'a> Unsearchable<'a> {
    fn new(directory: &'a Path) -> Self {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o000))
            .expect("the directory mode");
        Self(directory)
    }
}

impl Drop for Unsearchable<'_> {
    fn drop(&mut self) {
        let _ = fs::set_permissions(self.0, fs::Permissions::from_mode(0o755));
    }
}

#[test]
fn which_matches_bun_on_generated_path_layouts() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let output = Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/oracles/which.ts"
        ))
        .arg(directory.path())
        .output()
        .expect("bun runs the oracle");
    assert!(
        output.status.success(),
        "the oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply: Reply = garcon_js::json::from_slice(&output.stdout).expect("the oracle prints JSON");
    assert!(reply.cases.len() >= 110, "{} cases", reply.cases.len());
    // The unsearchable cases hold their directory only if their hold arrived.
    assert_eq!(
        reply
            .cases
            .iter()
            .filter(|case| case.hold_directory.is_some())
            .count(),
        2
    );

    let mut mismatches = Vec::new();
    for case in &reply.cases {
        let _hold = case
            .hold_directory
            .as_deref()
            .map(|directory| Unsearchable::new(Path::new(directory)));
        let actual = which_in(
            OsStr::new(&case.name),
            case.path.as_deref().map(OsStr::new),
            Path::new(&case.cwd),
        );
        let expected = case.expected.as_deref().map(PathBuf::from);
        if actual != expected {
            mismatches.push(format!(
                "{}: expected {}, got {}",
                case.label,
                case.expected
                    .as_deref()
                    .map_or_else(|| "null".to_owned(), |path| format!("{path:?}")),
                actual
                    .as_deref()
                    .map_or_else(|| "null".to_owned(), |path| format!("{path:?}"))
            ));
        }
    }
    assert!(
        mismatches.is_empty(),
        "{} of {} cases differ:\n{}",
        mismatches.len(),
        reply.cases.len(),
        mismatches.join("\n")
    );
}

#[test]
fn finds_a_shell_on_the_live_path() {
    let shell = which(OsStr::new("sh")).expect("sh is on the PATH of a test machine");
    let metadata = fs::metadata(&shell).expect("the shell exists");
    assert!(metadata.is_file() && metadata.mode() & 0o100 != 0);
}
