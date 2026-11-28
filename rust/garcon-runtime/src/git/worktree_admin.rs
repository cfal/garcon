//! Ports `server/runtime/git/worktree-admin.ts`.

use std::fs::Metadata;
use std::io::{self, ErrorKind};
use std::sync::LazyLock;

use garcon_base::concurrency::map_with_concurrency_result;
use garcon_base::path_boundary::realpath;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{path::native, trim};
use regress::{Flags, Regex};
use tokio::fs;

use super::worktree_layout::WorktreeLayout;
use super::worktree_record::WorktreeRecord;

const WORKTREE_ADMIN_READ_CONCURRENCY: f64 = 32.0;
const MAX_SYMREF_DEPTH: usize = 8;
const ASCII_SPACE: &[char] = &[' ', '\t', '\n', '\u{000B}', '\u{000C}', '\r'];

fn compile(pattern: &str, flags: Flags) -> Regex {
    // INFALLIBLE: the static expressions are valid ECMAScript patterns.
    Regex::with_flags(pattern, flags).expect("valid worktree metadata expression")
}

static CONFIG_COMMENT: LazyLock<Regex> = LazyLock::new(|| compile(r"\s*[#;].*$", Flags::default()));
static CONFIG_SECTION: LazyLock<Regex> =
    LazyLock::new(|| compile(r"^\s*\[\s*([a-z0-9.-]+)", Flags::from("i")));
static BARE_SETTING: LazyLock<Regex> =
    LazyLock::new(|| compile(r"^\s*bare(?:\s*=\s*(.*?))?\s*$", Flags::from("i")));
static QUOTED_BOOLEAN: LazyLock<Regex> = LazyLock::new(|| compile(r#"^"(.*)"$"#, Flags::default()));

struct HeadFields {
    branch: String,
    name: String,
}

enum LinkedRecord {
    Record(WorktreeRecord),
    Missing,
    UseGitFallback,
}

fn missing_path(error: &io::Error) -> bool {
    matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}

async fn read_text_or_none(path: &str) -> io::Result<Option<String>> {
    match fs::read(path).await {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
        Err(error) if missing_path(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn lstat_or_none(path: &str) -> io::Result<Option<Metadata>> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if missing_path(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn realpath_forgiving(file_path: &str) -> io::Result<String> {
    let mut unresolved = Vec::new();
    let mut candidate = file_path.to_owned();
    loop {
        match realpath(&candidate).await {
            Ok(path) => {
                let path = path.to_string_lossy();
                let parts: Vec<_> = std::iter::once(path.as_ref())
                    .chain(unresolved.iter().rev().map(String::as_str))
                    .collect();
                return Ok(native::join(&parts));
            }
            Err(error) if missing_path(&error) => {
                let parent = native::dirname(&candidate);
                if parent == candidate {
                    return Ok(file_path.to_owned());
                }
                unresolved.push(native::basename(&candidate));
                candidate = parent;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn read_admin_entries(worktrees_dir: &str) -> io::Result<Vec<String>> {
    let mut directory = match fs::read_dir(worktrees_dir).await {
        Ok(directory) => directory,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error),
    };
    let mut entries = Vec::new();
    while let Some(entry) = directory.next_entry().await? {
        entries.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(entries)
}

fn strip_git_dir_suffix(path: &str) -> &str {
    path.strip_suffix("/.git")
        .or_else(|| path.strip_suffix("\\.git"))
        .unwrap_or(path)
}

fn trim_git_file(content: Option<&str>) -> &str {
    content.unwrap_or_default().trim_end_matches(ASCII_SPACE)
}

fn fields_for_ref(reference: &str) -> HeadFields {
    let branch = reference.strip_prefix("refs/heads/").unwrap_or(reference);
    HeadFields {
        branch: branch.into(),
        name: branch.into(),
    }
}

fn git_boolean_is_enabled(raw: Option<&str>) -> bool {
    let value = trim(raw.unwrap_or("true"));
    let range = QUOTED_BOOLEAN
        .find(value)
        .and_then(|matched| matched.group(1));
    let value = range.map_or(value, |range| &value[range]);
    !matches!(
        value.to_lowercase().as_str(),
        "false" | "no" | "off" | "0" | ""
    )
}

fn config_requires_git_fallback(content: Option<&str>) -> bool {
    let Some(content) = content else {
        return true;
    };
    let mut section = String::new();
    for raw_line in content.split('\n') {
        let mut line = CONFIG_COMMENT
            .find(raw_line)
            .map_or(raw_line, |matched| &raw_line[..matched.start()]);
        if let Some(range) = CONFIG_SECTION
            .find(line)
            .and_then(|matched| matched.group(1))
        {
            section = line[range].to_lowercase();
            if matches!(section.as_str(), "include" | "includeif") {
                return true;
            }
            let Some((_, rest)) = line.split_once(']') else {
                return true;
            };
            line = rest;
        }
        if section == "core"
            && let Some(matched) = BARE_SETTING.find(line)
            && git_boolean_is_enabled(matched.group(1).map(|range| &line[range]))
        {
            return true;
        }
    }
    false
}

fn resolve_admin_ref_path(common_dir: &str, reference: &str) -> Option<String> {
    if !reference.starts_with("refs/") {
        return None;
    }
    let ref_path = native::resolve(common_dir, &[reference]);
    let relative = native::relative(common_dir, common_dir, &ref_path);
    if relative == ".."
        || relative
            .strip_prefix("..")
            .is_some_and(|tail| tail.starts_with(native::SEP))
        || native::is_absolute(&relative)
    {
        return None;
    }
    Some(ref_path)
}

async fn resolve_head_fields(
    common_dir: &str,
    content: Option<&str>,
    worktree_path: &str,
) -> io::Result<Option<HeadFields>> {
    let head = trim_git_file(content);
    let Some(reference) = head.strip_prefix("ref:") else {
        let detached =
            matches!(head.len(), 40 | 64) && head.bytes().all(|byte| byte.is_ascii_hexdigit());
        return Ok(Some(HeadFields {
            branch: if detached {
                "(detached)".into()
            } else {
                String::new()
            },
            name: native::basename(worktree_path),
        }));
    };
    let mut reference = reference.trim_start_matches(ASCII_SPACE).to_owned();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..MAX_SYMREF_DEPTH {
        if reference.is_empty() || !seen.insert(reference.clone()) {
            return Ok(None);
        }
        let Some(ref_path) = resolve_admin_ref_path(common_dir, &reference) else {
            return Ok(None);
        };
        let (content, stat) =
            tokio::try_join!(biased; read_text_or_none(&ref_path), lstat_or_none(&ref_path))?;
        if stat.is_some_and(|stat| stat.is_symlink()) {
            return Ok(None);
        }
        let head = trim_git_file(content.as_deref());
        let Some(next) = head.strip_prefix("ref:") else {
            return Ok(Some(fields_for_ref(&reference)));
        };
        reference = next.trim_start_matches(ASCII_SPACE).to_owned();
    }
    Ok(None)
}

async fn read_linked_worktree(common_dir: &str, admin_dir: String) -> io::Result<LinkedRecord> {
    let head_path = native::join(&[&admin_dir, "HEAD"]);
    let gitdir_path = native::join(&[&admin_dir, "gitdir"]);
    let (gitdir, head, stat) = tokio::try_join!(biased;
        read_text_or_none(&gitdir_path), read_text_or_none(&head_path), lstat_or_none(&head_path),
    )?;
    let Some(gitdir) = gitdir else {
        return Ok(LinkedRecord::Missing);
    };
    if stat.is_some_and(|stat| stat.is_symlink()) {
        return Ok(LinkedRecord::UseGitFallback);
    }
    let trimmed = trim_git_file(Some(&gitdir));
    if trimmed.is_empty() {
        return Ok(if gitdir.is_empty() {
            LinkedRecord::Missing
        } else {
            LinkedRecord::UseGitFallback
        });
    }
    let stored = strip_git_dir_suffix(trimmed);
    let worktree_path = if native::is_absolute(stored) {
        stored.to_owned()
    } else {
        realpath_forgiving(&native::resolve(&admin_dir, &[stored])).await?
    };
    let Some(fields) = resolve_head_fields(common_dir, head.as_deref(), &worktree_path).await?
    else {
        return Ok(LinkedRecord::UseGitFallback);
    };
    Ok(LinkedRecord::Record(WorktreeRecord {
        path: worktree_path,
        branch: fields.branch,
        name: fields.name,
        is_main: false,
    }))
}

pub async fn read_admin_worktree_records(
    layout: &WorktreeLayout,
) -> ExecutorResult<Option<Vec<WorktreeRecord>>> {
    let common_dir = realpath(&layout.common_dir)
        .await?
        .to_string_lossy()
        .into_owned();
    if native::basename(&common_dir) != ".git" {
        return Ok(None);
    }
    let main_path = native::dirname(&common_dir);
    let worktrees_dir = native::join(&[&common_dir, "worktrees"]);
    let head_path = native::join(&[&common_dir, "HEAD"]);
    let config_path = native::join(&[&common_dir, "config"]);
    let worktree_config_path = native::join(&[&common_dir, "config.worktree"]);
    let (head, head_stat, config, worktree_config, admin_entries) = tokio::try_join!(biased;
        read_text_or_none(&head_path), lstat_or_none(&head_path), read_text_or_none(&config_path),
        lstat_or_none(&worktree_config_path), read_admin_entries(&worktrees_dir),
    )?;
    if head_stat.is_some_and(|stat| stat.is_symlink())
        || worktree_config.is_some_and(|stat| !stat.is_file() || stat.len() != 0)
        || config_requires_git_fallback(config.as_deref())
    {
        return Ok(None);
    }
    let Some(fields) = resolve_head_fields(&common_dir, head.as_deref(), &main_path).await? else {
        return Ok(None);
    };
    let common_dir = common_dir.as_str();
    let results = map_with_concurrency_result(
        &admin_entries,
        WORKTREE_ADMIN_READ_CONCURRENCY,
        |entry, _| read_linked_worktree(common_dir, native::join(&[&worktrees_dir, entry])),
    )
    .await?;
    let mut records = vec![WorktreeRecord {
        path: main_path,
        branch: fields.branch,
        name: fields.name,
        is_main: true,
    }];
    for result in results {
        match result {
            LinkedRecord::Record(record) => records.push(record),
            LinkedRecord::Missing => {}
            LinkedRecord::UseGitFallback => return Ok(None),
        }
    }
    Ok(Some(records))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    struct AdminFixture {
        _root: tempfile::TempDir,
        repo: PathBuf,
        common: PathBuf,
        layout: WorktreeLayout,
    }

    impl AdminFixture {
        async fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let repo = realpath(root.path()).await.unwrap().join("repo");
            let common = repo.join(".git");
            fs::create_dir_all(common.join("worktrees")).await.unwrap();
            fs::write(common.join("HEAD"), "ref: refs/heads/main\n")
                .await
                .unwrap();
            fs::write(common.join("config"), "[core]\n\tbare = false\n")
                .await
                .unwrap();
            let layout = WorktreeLayout {
                worktree_root: repo.to_str().unwrap().into(),
                common_dir: common.to_str().unwrap().into(),
                ref_format: "files".into(),
            };
            Self {
                _root: root,
                repo,
                common,
                layout,
            }
        }

        async fn entry(&self, id: &str, gitdir: Option<&str>, head: Option<&str>) -> PathBuf {
            let directory = self.common.join("worktrees").join(id);
            fs::create_dir(&directory).await.unwrap();
            if let Some(gitdir) = gitdir {
                fs::write(directory.join("gitdir"), gitdir).await.unwrap();
            }
            if let Some(head) = head {
                fs::write(directory.join("HEAD"), head).await.unwrap();
            }
            directory
        }

        async fn records(&self) -> Option<Vec<WorktreeRecord>> {
            read_admin_worktree_records(&self.layout).await.unwrap()
        }
    }

    fn record(path: &Path, branch: &str, name: &str, is_main: bool) -> WorktreeRecord {
        WorktreeRecord {
            path: path.to_str().unwrap().into(),
            branch: branch.into(),
            name: name.into(),
            is_main,
        }
    }

    #[tokio::test]
    async fn reads_relative_and_absolute_gitdirs_with_git_compatible_head_states() {
        let fixture = AdminFixture::new().await;
        let paths = fixture.repo.join("paths");
        fs::create_dir_all(paths.join("Zed")).await.unwrap();
        fixture
            .entry(
                "relative",
                Some("../../../paths/Zed/.git\n"),
                Some("ref: refs/heads/feature\n"),
            )
            .await;
        for (id, head) in [
            ("apple", Some("a".repeat(40))),
            ("empty-head", None),
            ("external-ref", Some("ref: refs/custom/topic\n".into())),
        ] {
            let worktree = paths.join(id);
            fs::create_dir(&worktree).await.unwrap();
            let gitdir = format!("{}\n", worktree.join(".git").display());
            fixture.entry(id, Some(&gitdir), head.as_deref()).await;
        }
        fixture.entry("empty-gitdir", Some(""), None).await;
        fixture.entry("missing-gitdir", None, None).await;
        fs::write(fixture.common.join("worktrees/stray-file"), "ignored")
            .await
            .unwrap();

        let records = fixture.records().await.unwrap();
        assert_eq!(records[0], record(&fixture.repo, "main", "main", true));
        assert_eq!(records.len(), 5);
        assert!(records.contains(&record(&paths.join("Zed"), "feature", "feature", false)));
        assert!(records.contains(&record(&paths.join("apple"), "(detached)", "apple", false)));
        assert!(records.contains(&record(&paths.join("empty-head"), "", "empty-head", false)));
        assert!(records.contains(&record(
            &paths.join("external-ref"),
            "refs/custom/topic",
            "refs/custom/topic",
            false
        )));
    }

    #[tokio::test]
    async fn declines_bare_and_separate_git_directory_layouts() {
        let mut fixture = AdminFixture::new().await;
        let separate = fixture.repo.join("repository.git");
        fs::create_dir(&separate).await.unwrap();
        fixture.layout.common_dir = separate.to_str().unwrap().into();
        assert!(fixture.records().await.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn declines_symlink_based_head_refs_in_the_main_and_linked_worktrees() {
        let fixture = AdminFixture::new().await;
        let gitdir = format!("{}\n", fixture.repo.join("linked/.git").display());
        let admin = fixture.entry("linked", Some(&gitdir), None).await;
        std::os::unix::fs::symlink("refs/heads/linked", admin.join("HEAD")).unwrap();
        assert!(fixture.records().await.is_none());
        fs::remove_file(admin.join("HEAD")).await.unwrap();
        let main_head = fixture.common.join("HEAD");
        fs::remove_file(&main_head).await.unwrap();
        std::os::unix::fs::symlink("refs/heads/main", main_head).unwrap();
        assert!(fixture.records().await.is_none());
    }

    #[tokio::test]
    async fn declines_bare_and_per_worktree_config_layouts() {
        let fixture = AdminFixture::new().await;
        let config = fixture.common.join("config");
        for bare in ["[core] bare = true\n", "[core]\n\tbare = true\n"] {
            fs::write(&config, bare).await.unwrap();
            assert!(fixture.records().await.is_none());
        }
        fs::write(config, "[core]\n\tbare = false\n").await.unwrap();
        fs::write(fixture.common.join("config.worktree"), "[core]\n")
            .await
            .unwrap();
        assert!(fixture.records().await.is_none());
    }

    #[tokio::test]
    async fn declines_non_empty_gitdir_metadata_that_trims_to_empty() {
        let fixture = AdminFixture::new().await;
        fixture.entry("blank-gitdir", Some(" \t\n"), None).await;
        assert!(fixture.records().await.is_none());
    }

    #[tokio::test]
    async fn accepts_only_an_empty_regular_worktree_config() {
        let fixture = AdminFixture::new().await;
        let config = fixture.common.join("config.worktree");
        let expected = fixture.records().await.unwrap();
        fs::write(&config, "").await.unwrap();
        assert_eq!(fixture.records().await.unwrap(), expected);
        fs::write(&config, " \n").await.unwrap();
        assert!(fixture.records().await.is_none());
        fs::remove_file(&config).await.unwrap();
        #[cfg(unix)]
        {
            let empty = fixture.common.join("empty-config");
            fs::write(&empty, "").await.unwrap();
            std::os::unix::fs::symlink(empty, &config).unwrap();
            assert!(fixture.records().await.is_none());
            fs::remove_file(&config).await.unwrap();
        }
        fs::create_dir(&config).await.unwrap();
        assert!(fixture.records().await.is_none());
    }

    #[tokio::test]
    async fn resolves_chained_head_symrefs() {
        let fixture = AdminFixture::new().await;
        let custom = fixture.common.join("refs/custom");
        fs::create_dir_all(&custom).await.unwrap();
        fs::write(fixture.common.join("HEAD"), "ref: refs/custom/mid\n")
            .await
            .unwrap();
        fs::write(custom.join("mid"), "ref: refs/heads/topic\n")
            .await
            .unwrap();
        assert_eq!(
            fixture.records().await.unwrap()[0],
            record(&fixture.repo, "topic", "topic", true)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolves_the_existing_prefix_of_a_missing_relative_worktree() {
        let fixture = AdminFixture::new().await;
        let actual = fixture.repo.join("actual");
        fs::create_dir(&actual).await.unwrap();
        std::os::unix::fs::symlink(&actual, fixture.repo.join("linked")).unwrap();
        fixture
            .entry(
                "missing-relative",
                Some("../../../linked/missing/.git\n"),
                Some("ref: refs/heads/missing\n"),
            )
            .await;
        assert_eq!(
            fixture.records().await.unwrap()[1],
            record(&actual.join("missing"), "missing", "missing", false)
        );
    }

    #[tokio::test]
    async fn propagates_structural_read_failures_for_the_git_fallback() {
        let fixture = AdminFixture::new().await;
        let worktrees = fixture.common.join("worktrees");
        fs::remove_dir(&worktrees).await.unwrap();
        fs::write(worktrees, "not a directory").await.unwrap();
        assert!(read_admin_worktree_records(&fixture.layout).await.is_err());
    }
}
