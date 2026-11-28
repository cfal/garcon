use std::io;
use std::path::{Path, PathBuf};

use garcon_js::path::posix;
use tokio::fs;

pub const PROJECT_BOUNDARY_ERROR_CODE: &str = "outside_project_base";
pub const PROJECT_BOUNDARY_ERROR_MESSAGE: &str = "Path is outside the allowed base directory";

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct ProjectBoundaryError {
    pub message: String,
}

impl Default for ProjectBoundaryError {
    fn default() -> Self {
        Self {
            message: PROJECT_BOUNDARY_ERROR_MESSAGE.into(),
        }
    }
}

impl ProjectBoundaryError {
    pub const ERROR_CODE: &'static str = PROJECT_BOUNDARY_ERROR_CODE;
    pub const STATUS: u16 = 403;
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectPathError {
    #[error(transparent)]
    Boundary(#[from] ProjectBoundaryError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

pub fn is_project_boundary_error(error: &(dyn std::error::Error + 'static)) -> bool {
    error.is::<ProjectBoundaryError>()
        || error
            .downcast_ref::<ProjectPathError>()
            .is_some_and(|error| matches!(error, ProjectPathError::Boundary(_)))
}

fn within_resolved_root(root: &str, target: &str) -> bool {
    let relative = posix::relative("/", root, target);
    relative.is_empty()
        || (relative != ".." && !relative.starts_with("../") && !posix::is_absolute(&relative))
}

fn resolve(target: &str) -> io::Result<String> {
    if posix::is_absolute(target) {
        return Ok(posix::resolve("/", &[target]));
    }
    let cwd = std::env::current_dir()?;
    Ok(posix::resolve(&cwd.to_string_lossy(), &[target]))
}

pub async fn realpath(path: impl AsRef<Path>) -> io::Result<PathBuf> {
    let path = path.as_ref();
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::ffi::OsStrExt;
        // Bun 1.4.3 rejects backslashes in realpath input, but not in its output.
        if path.as_os_str().as_bytes().contains(&b'\\') {
            return Err(io::Error::from_raw_os_error(libc::ENOENT));
        }
    }
    fs::canonicalize(path).await
}

async fn resolve_real_path_allow_missing(target: &str) -> io::Result<String> {
    let mut candidate = resolve(target)?;
    let mut missing_segments = Vec::new();
    let real_ancestor = loop {
        match realpath(&candidate).await {
            Ok(real) => break real,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                match fs::symlink_metadata(&candidate).await {
                    Ok(_) => return Err(error),
                    Err(check) if check.kind() == io::ErrorKind::NotFound => {}
                    Err(check) => return Err(check),
                }
                let parent = posix::dirname(&candidate);
                if parent == candidate {
                    return Err(error);
                }
                missing_segments.push(posix::basename(&candidate));
                candidate = parent;
            }
            Err(error) => return Err(error),
        }
    };
    let real_ancestor = real_ancestor.to_string_lossy();
    let mut segments = vec![real_ancestor.as_ref()];
    segments.extend(missing_segments.iter().rev().map(String::as_str));
    Ok(posix::resolve("/", &segments))
}

pub async fn resolve_real_within_base(root: &str, input: &str) -> Result<String, ProjectPathError> {
    let root = resolve(root)?;
    let input = posix::resolve(&root, &[input]);
    if !within_resolved_root(&root, &input) {
        return Err(ProjectBoundaryError::default().into());
    }
    let real_root = resolve_real_path_allow_missing(&root).await?;
    resolve_real_within_canonical_base(&real_root, &input).await
}

pub async fn resolve_real_within_canonical_base(
    canonical_root: &str,
    input: &str,
) -> Result<String, ProjectPathError> {
    let root = resolve(canonical_root)?;
    let input = posix::resolve(&root, &[input]);
    let target = resolve_real_path_allow_missing(&input).await?;
    if !within_resolved_root(&root, &target) {
        return Err(ProjectBoundaryError::default().into());
    }
    Ok(target)
}

pub async fn assert_real_within_base(root: &str, target: &str) -> Result<String, ProjectPathError> {
    let root = resolve(root)?;
    let target = posix::resolve(&root, &[target]);
    if within_resolved_root(&root, &target) {
        return resolve_real_within_base(&root, &target).await;
    }
    let real_root = resolve_real_path_allow_missing(&root).await?;
    let real_target = resolve_real_path_allow_missing(&target).await?;
    if !within_resolved_root(&real_root, &real_target) {
        return Err(ProjectBoundaryError::default().into());
    }
    Ok(real_target)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn accepts_an_in_base_directory_whose_name_begins_with_two_dots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_str().unwrap();
        let project = temp.path().join("..cache");
        fs::create_dir(&project).await.unwrap();
        assert_eq!(
            resolve_real_within_base(root, "..cache").await.unwrap(),
            project.canonicalize().unwrap().to_str().unwrap(),
        );
    }

    #[tokio::test]
    async fn rejects_a_symlink_leading_outside_and_does_not_treat_a_dangling_symlink_as_missing() {
        let temp = tempfile::tempdir().unwrap();
        let allowed = temp.path().join("allowed");
        fs::create_dir(&allowed).await.unwrap();
        std::os::unix::fs::symlink(temp.path(), allowed.join("outside")).unwrap();
        std::os::unix::fs::symlink(allowed.join("nowhere"), allowed.join("dangling")).unwrap();
        let root = allowed.to_str().unwrap();
        let error = resolve_real_within_base(root, "outside/not-created")
            .await
            .unwrap_err();
        assert!(is_project_boundary_error(&error));
        let error = resolve_real_within_base(root, "dangling/not-created")
            .await
            .unwrap_err();
        assert!(
            matches!(error, ProjectPathError::Io(error) if error.kind() == io::ErrorKind::NotFound)
        );
    }

    #[tokio::test]
    async fn accepts_canonical_targets_through_an_alias_only_when_asserting() {
        let temp = tempfile::tempdir().unwrap();
        let allowed = temp.path().join("allowed");
        let alias = temp.path().join("alias");
        fs::create_dir(&allowed).await.unwrap();
        std::os::unix::fs::symlink(&allowed, &alias).unwrap();
        let target = allowed.canonicalize().unwrap().join("not-created");
        let target = target.to_str().unwrap();
        let alias = alias.to_str().unwrap();
        assert_eq!(
            assert_real_within_base(alias, target).await.unwrap(),
            target
        );
        let error = resolve_real_within_base(alias, target).await.unwrap_err();
        assert!(is_project_boundary_error(&error));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn applies_the_pinned_bun_realpath_rule_only_to_its_input() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_str().unwrap();
        let literal = temp.path().join(r"back\slash");
        let alias = temp.path().join("alias");
        fs::create_dir(&literal).await.unwrap();
        std::os::unix::fs::symlink(&literal, &alias).unwrap();
        let direct = resolve_real_within_base(root, r"back\slash")
            .await
            .unwrap_err();
        assert!(
            matches!(direct, ProjectPathError::Io(error) if error.kind() == io::ErrorKind::NotFound)
        );
        assert_eq!(
            resolve_real_within_base(root, "alias").await.unwrap(),
            literal.to_str().unwrap()
        );
        assert_eq!(
            resolve_real_within_base(root, r"missing\file")
                .await
                .unwrap(),
            format!(r"{root}/missing\file")
        );
    }
}
