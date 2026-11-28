//! `Bun.which`: the path of an executable on the PATH the process started with.
//!
//! No TypeScript file is ported here. The original calls the Bun API directly
//! to learn whether a provider CLI is installed and where (`Bun.which
//! ('opencode')`, and the same for every other CLI), so the lookup lives once
//! here for every integration. The behavior is the one Bun 1.4.3 showed on
//! generated PATH layouts on Linux as an unprivileged user;
//! `tests/which_oracle.rs` replays those layouts against this module.
//!
//! - A name without a separator is searched on PATH, split at `:`, in order.
//!   An empty segment is skipped; it does not stand for the working directory.
//!   A relative segment is joined to the working directory as it is, without
//!   normalizing `.` or `..`, and the answer keeps that form.
//! - A name with a separator is not searched: it is checked as given, after a
//!   leading `//` loses one slash, and a relative one is joined to the working
//!   directory without its leading `./`.
//! - A candidate matches when it is a regular file whose owner execute bit is
//!   set; no other permission bit is consulted. Directories, FIFOs, device
//!   nodes, and files without that bit are skipped, and the search goes on.
//! - `Bun.which` reads PATH from the environment the process started with and
//!   ignores a PATH changed later through `process.env`. A worker never
//!   changes its environment, so the live PATH is that one.
//! - Windows is compile-checked only: Bun.which was not probed there.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

/// `Bun.which(name)`: the path of the first executable `name` on the live
/// PATH, or `None`.
pub fn which(name: &OsStr) -> Option<PathBuf> {
    let path = std::env::var_os("PATH");
    // A deleted working directory leaves nothing to join a relative entry to.
    let cwd = std::env::current_dir().unwrap_or_default();
    which_in(name, path.as_deref(), &cwd)
}

/// `Bun.which(name)` on the given PATH and working directory, for callers and
/// tests that supply them.
pub fn which_in(name: &OsStr, path: Option<&OsStr>, cwd: &Path) -> Option<PathBuf> {
    platform::which_in(name, path, cwd)
}

#[cfg(unix)]
mod platform {
    use std::ffi::{OsStr, OsString};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};

    const SEPARATOR: u8 = b'/';
    const OWNER_EXECUTE: u32 = 0o100;

    pub fn which_in(name: &OsStr, path: Option<&OsStr>, cwd: &Path) -> Option<PathBuf> {
        let name = name.as_bytes();
        if name.is_empty() {
            return None;
        }
        if name.contains(&SEPARATOR) {
            let name = if name.starts_with(b"//") {
                &name[1..]
            } else {
                name
            };
            let candidate = if name.starts_with(&[SEPARATOR]) {
                name.to_vec()
            } else {
                join(
                    cwd.as_os_str().as_bytes(),
                    name.strip_prefix(b"./").unwrap_or(name),
                )
            };
            return executable(Path::new(OsStr::from_bytes(&candidate)))
                .then(|| PathBuf::from(OsString::from_vec(candidate)));
        }
        let path = path?.as_bytes();
        for segment in path.split(|byte| *byte == b':') {
            if segment.is_empty() {
                continue;
            }
            let directory = if segment.starts_with(&[SEPARATOR]) {
                segment.to_vec()
            } else {
                join(cwd.as_os_str().as_bytes(), segment)
            };
            let candidate = join(&directory, name);
            if executable(Path::new(OsStr::from_bytes(&candidate))) {
                return Some(PathBuf::from(OsString::from_vec(candidate)));
            }
        }
        None
    }

    // Two components joined by one slash, whether or not the first ends with one.
    fn join(left: &[u8], right: &[u8]) -> Vec<u8> {
        let mut joined = Vec::with_capacity(left.len() + 1 + right.len());
        joined.extend_from_slice(left);
        if !left.ends_with(&[SEPARATOR]) {
            joined.push(SEPARATOR);
        }
        joined.extend_from_slice(right);
        joined
    }

    fn executable(path: &Path) -> bool {
        // `metadata` follows symlinks, as the original's check does.
        std::fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.mode() & OWNER_EXECUTE != 0)
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::{OsStr, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};

    // Bun.which was not probed on Windows. This follows the lookup Windows
    // commands get: PATH is split at `;`, a name without an extension is
    // tried with each of PATHEXT, and any regular file is a match.
    const DEFAULT_PATH_EXT: &[&str] = &[".com", ".exe", ".bat", ".cmd"];

    pub fn which_in(name: &OsStr, path: Option<&OsStr>, cwd: &Path) -> Option<PathBuf> {
        let name = name.encode_wide().collect::<Vec<_>>();
        if name.is_empty() {
            return None;
        }
        let extensions = if name.contains(&(b'.' as u16)) || has_separator(&name) {
            vec![String::new()]
        } else {
            path_extensions()
        };
        let directories = if has_separator(&name) {
            vec![PathBuf::new()]
        } else {
            let path = path?;
            std::env::split_paths(path)
                .filter(|segment| !segment.as_os_str().is_empty())
                .map(|segment| {
                    if segment.is_absolute() {
                        segment
                    } else {
                        cwd.join(segment)
                    }
                })
                .collect()
        };
        for directory in directories {
            for extension in &extensions {
                let mut candidate = directory.as_os_str().encode_wide().collect::<Vec<_>>();
                let last = candidate.last().copied();
                if !candidate.is_empty() && last != Some(b'\\' as u16) && last != Some(b'/' as u16)
                {
                    candidate.push(b'\\' as u16);
                }
                candidate.extend_from_slice(&name);
                candidate.extend(extension.encode_utf16());
                let candidate = PathBuf::from(OsString::from_wide(&candidate));
                if std::fs::metadata(&candidate).is_ok_and(|metadata| metadata.is_file()) {
                    return Some(candidate);
                }
            }
        }
        None
    }

    fn path_extensions() -> Vec<String> {
        let configured = std::env::var("PATHEXT").unwrap_or_default();
        let extensions: Vec<String> = configured
            .split(';')
            .filter(|extension| !extension.is_empty())
            .map(str::to_owned)
            .collect();
        if extensions.is_empty() {
            DEFAULT_PATH_EXT
                .iter()
                .map(|extension| (*extension).to_owned())
                .collect()
        } else {
            extensions
        }
    }

    fn has_separator(name: &[u16]) -> bool {
        name.contains(&(b'\\' as u16))
            || name.contains(&(b'/' as u16))
            || name.get(1) == Some(&(b':' as u16))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::ffi::OsStr;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use super::which_in;

    struct Layout {
        _root: tempfile::TempDir,
        root: String,
        first: String,
        second: String,
    }

    fn executable(path: &Path, mode: u32) {
        fs::write(path, "#!/bin/sh\n").expect("the file");
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("the mode");
    }

    // `first` holds an executable `tool`, a `tool`-like directory, a `silent`
    // file with every bit but the owner's, and a `both` file that is not
    // executable; `second` holds `tool` and an executable `both`.
    fn layout() -> Layout {
        let root = tempfile::tempdir().expect("a temporary directory");
        let (first, second) = (root.path().join("first"), root.path().join("second"));
        for directory in [&first, &second] {
            fs::create_dir(directory).expect("the directory");
        }
        executable(&first.join("tool"), 0o755);
        executable(&first.join("silent"), 0o677);
        executable(&first.join("both"), 0o644);
        fs::create_dir(first.join("directory")).expect("the directory");
        executable(&second.join("tool"), 0o100);
        executable(&second.join("both"), 0o755);
        std::os::unix::fs::symlink(first.join("tool"), first.join("link")).expect("the symlink");
        std::os::unix::fs::symlink(first.join("missing"), first.join("broken"))
            .expect("the symlink");
        std::os::unix::fs::symlink(&first, root.path().join("linked")).expect("the symlink");
        let text = |path: &Path| path.to_str().expect("UTF-8").to_owned();
        Layout {
            _root: root,
            root: text(first.parent().expect("the parent")),
            first: text(&first),
            second: text(&second),
        }
    }

    fn lookup(name: &str, path: Option<&str>, cwd: &str) -> Option<PathBuf> {
        which_in(OsStr::new(name), path.map(OsStr::new), Path::new(cwd))
    }

    #[test]
    fn searches_the_path_in_order_for_an_executable_regular_file() {
        let layout = layout();
        let (root, first, second) = (&layout.root, &layout.first, &layout.second);
        let path = format!("{first}:{second}");
        for (name, expected) in [
            ("tool", Some(format!("{first}/tool"))),
            ("link", Some(format!("{first}/link"))),
            ("broken", None),
            ("silent", None),
            ("directory", None),
            ("TOOL", None),
            ("missing", None),
            ("", None),
            ("first/tool", Some(format!("{root}/first/tool"))),
        ] {
            assert_eq!(
                lookup(name, Some(&path), root),
                expected.map(PathBuf::from),
                "{name}"
            );
        }
        assert_eq!(
            lookup("tool", Some(&format!("{second}:{first}")), root),
            Some(PathBuf::from(format!("{second}/tool")))
        );
        // A file without the owner execute bit is passed over for a later match.
        assert_eq!(
            lookup("both", Some(&path), root),
            Some(PathBuf::from(format!("{second}/both")))
        );
        // Only the owner execute bit counts, whichever other bits are set.
        fs::set_permissions(
            Path::new(first).join("silent"),
            fs::Permissions::from_mode(0o100),
        )
        .expect("the mode");
        assert_eq!(
            lookup("silent", Some(&path), root),
            Some(PathBuf::from(format!("{first}/silent")))
        );
        // Without PATH a plain name is not searched.
        assert_eq!(lookup("tool", None, root), None);
        assert_eq!(lookup("tool", Some(""), root), None);
    }

    #[test]
    fn joins_entries_to_the_working_directory_without_normalizing_them() {
        let layout = layout();
        let (root, first) = (&layout.root, &layout.first);
        for (entry, expected) in [
            ("first", Some(format!("{root}/first/tool"))),
            ("./first", Some(format!("{root}/./first/tool"))),
            ("first/", Some(format!("{root}/first/tool"))),
            ("first//", Some(format!("{root}/first//tool"))),
            (".", None),
            ("", None),
            (":first", Some(format!("{root}/first/tool"))),
            ("first:", Some(format!("{root}/first/tool"))),
            ("::", None),
            ("missing:first", Some(format!("{root}/first/tool"))),
            ("linked", Some(format!("{root}/linked/tool"))),
        ] {
            assert_eq!(
                lookup("tool", Some(entry), root),
                expected.map(PathBuf::from),
                "{entry}"
            );
        }
        for (suffix, expected) in [
            ("", Some(format!("{first}/tool"))),
            ("/", Some(format!("{first}/tool"))),
            ("//", Some(format!("{first}//tool"))),
            ("/missing", None),
        ] {
            let entry = format!("{first}{suffix}");
            assert_eq!(
                lookup("tool", Some(&entry), root),
                expected.map(PathBuf::from),
                "{entry}"
            );
        }
        // A relative entry is joined to the working directory the caller names.
        assert_eq!(
            lookup("tool", Some("."), first),
            Some(PathBuf::from(format!("{first}/./tool")))
        );
    }

    #[test]
    fn checks_a_name_with_a_separator_as_given_without_the_path() {
        let layout = layout();
        let (root, first) = (&layout.root, &layout.first);
        for (name, cwd, expected) in [
            ("tool", first, None),
            ("./tool", first, Some(format!("{first}/tool"))),
            ("./first/tool", root, Some(format!("{first}/tool"))),
            ("first//tool", root, Some(format!("{root}/first//tool"))),
            (
                "first/../first/tool",
                root,
                Some(format!("{root}/first/../first/tool")),
            ),
            (
                "../first/tool",
                first,
                Some(format!("{first}/../first/tool")),
            ),
            ("./link", first, Some(format!("{first}/link"))),
            ("./silent", first, None),
            ("./broken", first, None),
            ("./directory", first, None),
            ("./directory/", first, None),
            ("./tool/", first, None),
            (".", first, None),
            ("./", first, None),
            ("..", first, None),
            ("", first, None),
            ("/", first, None),
            ("./missing", first, None),
            ("~/tool", first, None),
        ] {
            assert_eq!(
                lookup(name, None, cwd),
                expected.map(PathBuf::from),
                "{name}"
            );
        }
        for (name, expected) in [
            ("tool", Some(format!("{first}/tool"))),
            ("link", Some(format!("{first}/link"))),
            ("silent", None),
            ("broken", None),
            ("directory", None),
            ("tool/", None),
            ("", None),
        ] {
            let name = format!("{first}/{name}");
            assert_eq!(
                lookup(&name, None, root),
                expected.map(PathBuf::from),
                "{name}"
            );
        }
        // A leading `//` loses one slash, and each further slash stays.
        assert_eq!(
            lookup(&format!("/{first}/tool"), None, root),
            Some(PathBuf::from(format!("{first}/tool")))
        );
        assert_eq!(
            lookup(&format!("//{first}/tool"), None, root),
            Some(PathBuf::from(format!("/{first}/tool")))
        );
    }
}
