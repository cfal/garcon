use std::{io, path::Path, rc::Rc};

use garcon_base::path_boundary::realpath;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    host::AgentLogger,
    resources::ExecutorResult,
};
use garcon_js::{json::Opaque, path::native as path};
use icu_normalizer::ComposingNormalizer;
use indexmap::{IndexMap, IndexSet};
use serde_json::Value;
use tokio::fs;

const MAX_SANITIZED_LENGTH: usize = 200;

pub struct ClaudeNativePathOptions<'a> {
    pub home_dir: &'a str,
    pub config_home_dir: Option<&'a str>,
    pub logger: Option<Rc<dyn AgentLogger>>,
}

pub struct ClaudeNativePathSession<'a> {
    pub project_path: &'a str,
    pub agent_session_id: Option<&'a str>,
    pub native_path: Option<&'a str>,
}

pub struct ClaudeNativeSessionRelocation {
    pub native_path: String,
    artifacts: Option<(ClaudeSessionArtifacts, ClaudeSessionArtifacts)>,
    logger: Option<Rc<dyn AgentLogger>>,
}

impl ClaudeNativeSessionRelocation {
    pub async fn commit(&self) -> Result<(), AgentIntegrationError> {
        if let Some((source, _)) = &self.artifacts {
            remove_claude_session_artifacts(source)
                .await
                .map_err(|error| relocation_error(self.logger.as_deref(), "commit", error))?;
        }
        Ok(())
    }

    pub async fn rollback(&self) -> Result<(), AgentIntegrationError> {
        if let Some((_, target)) = &self.artifacts {
            remove_claude_session_artifacts(target)
                .await
                .map_err(|error| relocation_error(self.logger.as_deref(), "rollback", error))?;
        }
        Ok(())
    }
}

fn simple_hash(value: &str) -> String {
    let hash = value.encode_utf16().fold(0_i32, |hash, unit| {
        hash.wrapping_mul(31).wrapping_add(i32::from(unit))
    });
    let mut magnitude = hash.unsigned_abs();
    let mut digits = Vec::new();
    loop {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(magnitude % 36) as usize]);
        magnitude /= 36;
        if magnitude == 0 {
            break;
        }
    }
    digits.into_iter().rev().map(char::from).collect()
}

pub fn sanitize_claude_project_path(project_path: &str) -> String {
    let mut units = project_path.encode_utf16();
    let mut sanitized: String = units
        .by_ref()
        .take(MAX_SANITIZED_LENGTH)
        .map(|unit| {
            u8::try_from(unit)
                .ok()
                .filter(u8::is_ascii_alphanumeric)
                .map_or('-', char::from)
        })
        .collect();
    if units.next().is_some() {
        sanitized.push('-');
        sanitized.push_str(&simple_hash(project_path));
    }
    sanitized
}

fn nfc(text: &str) -> String {
    ComposingNormalizer::new_nfc().normalize(text).into_owned()
}

pub fn claude_config_home_dir(options: &ClaudeNativePathOptions<'_>) -> String {
    match options.config_home_dir {
        Some(config) => nfc(config),
        None => nfc(&path::join(&[options.home_dir, ".claude"])),
    }
}

pub fn claude_projects_dir(options: &ClaudeNativePathOptions<'_>) -> String {
    path::join(&[&claude_config_home_dir(options), "projects"])
}

async fn canonicalize_project_path(project_path: &str) -> String {
    match realpath(project_path).await {
        Ok(canonical) => nfc(&canonical.to_string_lossy()),
        Err(_) => nfc(project_path),
    }
}

fn transcript_file_name(agent_session_id: &str) -> String {
    format!("{agent_session_id}.jsonl")
}

fn config_home_dir_from_native_path(native_path: &str, session_id: &str) -> Option<String> {
    if path::basename(native_path) != transcript_file_name(session_id) {
        return None;
    }
    let projects_dir = path::dirname(&path::dirname(native_path));
    (path::basename(&projects_dir) == "projects").then(|| path::dirname(&projects_dir))
}

fn is_missing_path(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
    )
}

fn transcript_unavailable(message: &'static str) -> AgentIntegrationError {
    AgentIntegrationError::new(
        AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
        message,
        false,
        None,
    )
}

async fn is_file(path: &str) -> ExecutorResult<bool> {
    match fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err(transcript_unavailable("Claude native transcript is not a file").into()),
        Err(error) if is_missing_path(&error) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub async fn create_claude_native_path(
    project_path: &str,
    agent_session_id: &str,
    options: &ClaudeNativePathOptions<'_>,
) -> Option<String> {
    if project_path.is_empty() || agent_session_id.is_empty() {
        return None;
    }
    let project_directory =
        sanitize_claude_project_path(&canonicalize_project_path(project_path).await);
    if project_directory.is_empty() {
        return None;
    }
    Some(path::join(&[
        &claude_projects_dir(options),
        &project_directory,
        &transcript_file_name(agent_session_id),
    ]))
}

fn logger_fields<const N: usize>(values: [(&str, Value); N]) -> IndexMap<String, Opaque> {
    values
        .into_iter()
        .map(|(name, value)| (name.to_owned(), Opaque::from_value(value)))
        .collect()
}

async fn search_claude_projects(
    session_id: &str,
    options: &ClaudeNativePathOptions<'_>,
) -> ExecutorResult<Vec<String>> {
    let projects_dir = claude_projects_dir(options);
    let mut directories = match fs::read_dir(&projects_dir).await {
        Ok(directories) => directories,
        Err(error) if is_missing_path(&error) => {
            if let Some(logger) = &options.logger {
                logger.warn(
                    "Claude transcript search directory is unavailable",
                    Some(&logger_fields([
                        ("projectsDir", Value::String(projects_dir)),
                        ("error", Value::String(error.to_string())),
                    ])),
                );
            }
            return Ok(Vec::new());
        }
        Err(error) => return Err(error.into()),
    };
    let mut names = Vec::new();
    while let Some(entry) = directories.next_entry().await? {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    let file_name = transcript_file_name(session_id);
    let mut matches = Vec::new();
    for directory in names {
        let candidate = path::join(&[&projects_dir, &directory, &file_name]);
        if is_file(&candidate).await? {
            matches.push(candidate);
        }
    }
    Ok(matches)
}

pub async fn resolve_claude_native_path(
    session: ClaudeNativePathSession<'_>,
    options: &ClaudeNativePathOptions<'_>,
) -> ExecutorResult<Option<String>> {
    let Some(session_id) = session.agent_session_id.filter(|id| !id.is_empty()) else {
        return Ok(None);
    };
    let native_path = session.native_path.filter(|path| !path.is_empty());
    if let Some(path) = native_path
        && is_file(path).await?
    {
        return Ok(Some(path.to_owned()));
    }
    let unique_config_homes: IndexSet<_> = native_path
        .and_then(|path| config_home_dir_from_native_path(path, session_id))
        .into_iter()
        .chain(std::iter::once(claude_config_home_dir(options)))
        .filter(|path| !path.is_empty())
        .collect();
    let home_options = |home| ClaudeNativePathOptions {
        home_dir: options.home_dir,
        config_home_dir: Some(home),
        logger: options.logger.clone(),
    };
    for config_home in &unique_config_homes {
        let derived =
            create_claude_native_path(session.project_path, session_id, &home_options(config_home))
                .await;
        if let Some(derived_path) = derived
            && is_file(&derived_path).await?
        {
            if let Some(logger) = &options.logger
                && native_path.is_some_and(|stored| stored != derived_path)
            {
                logger.warn(
                    "Claude stored transcript path is unavailable; using derived path",
                    Some(&logger_fields([
                        ("agentSessionId", Value::String(session_id.to_owned())),
                        ("derivedPath", Value::String(derived_path.clone())),
                    ])),
                );
            }
            return Ok(Some(derived_path));
        }
    }
    if let Some(logger) = &options.logger {
        logger.warn(
            "Claude expected transcript path is unavailable; searching projects",
            Some(&logger_fields([
                ("agentSessionId", Value::String(session_id.to_owned())),
                (
                    "searchDirectories",
                    Value::Array(
                        unique_config_homes
                            .iter()
                            .map(|home| Value::String(claude_projects_dir(&home_options(home))))
                            .collect(),
                    ),
                ),
            ])),
        );
    }
    let matches: IndexSet<_> =
        futures::future::try_join_all(unique_config_homes.iter().map(|home| async move {
            search_claude_projects(session_id, &home_options(home)).await
        }))
        .await?
        .into_iter()
        .flatten()
        .collect();
    match matches.len() {
        0 => Ok(None),
        1 => {
            let path = matches.into_iter().next();
            if let Some(logger) = &options.logger
                && let Some(path) = &path
            {
                logger.warn(
                    "Claude transcript path recovered by session search",
                    Some(&logger_fields([
                        ("agentSessionId", Value::String(session_id.to_owned())),
                        ("nativePath", Value::String(path.clone())),
                    ])),
                );
            }
            Ok(path)
        }
        _ => {
            if let Some(logger) = &options.logger {
                logger.error(
                    "Claude transcript search found multiple files and refused to choose",
                    Some(&logger_fields([
                        ("agentSessionId", Value::String(session_id.to_owned())),
                        (
                            "matches",
                            Value::Array(matches.into_iter().map(Value::String).collect()),
                        ),
                    ])),
                );
            }
            Err(transcript_unavailable(
                "Multiple Claude native transcripts match the selected session",
            )
            .into())
        }
    }
}

const OUTSIDE_PROJECT_STATE: &str =
    "Claude session transcript is outside the expected project-state directory";

fn is_safe_session_path_segment(id: &str) -> bool {
    !matches!(id, "" | "." | "..") && path::basename(id) == id
}

struct ClaudeSessionArtifacts {
    transcript_path: String,
    queue_path: String,
    support_path: String,
}

fn session_artifacts(transcript_path: String, agent_session_id: &str) -> ClaudeSessionArtifacts {
    let project_directory = path::dirname(&transcript_path);
    ClaudeSessionArtifacts {
        transcript_path,
        queue_path: path::join(&[
            &project_directory,
            &format!("{agent_session_id}.queue.json"),
        ]),
        support_path: path::join(&[&project_directory, agent_session_id]),
    }
}

fn ignore_not_found(result: io::Result<()>) -> io::Result<()> {
    match result {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

async fn remove_support_path(path: &str) -> io::Result<()> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_dir() => ignore_not_found(fs::remove_dir_all(path).await),
        Ok(metadata) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::FileTypeExt;
                if metadata.file_type().is_symlink_dir() {
                    return ignore_not_found(fs::remove_dir(path).await);
                }
            }
            let _ = metadata;
            ignore_not_found(fs::remove_file(path).await)
        }
        Err(error) => ignore_not_found(Err(error)),
    }
}

async fn remove_claude_session_artifacts(artifacts: &ClaudeSessionArtifacts) -> io::Result<()> {
    let (transcript, queue, support) = tokio::join!(
        fs::remove_file(&artifacts.transcript_path),
        fs::remove_file(&artifacts.queue_path),
        remove_support_path(&artifacts.support_path),
    );
    ignore_not_found(transcript)?;
    ignore_not_found(queue)?;
    support
}

fn relocation_error(
    logger: Option<&dyn AgentLogger>,
    operation: &str,
    error: impl std::fmt::Display,
) -> AgentIntegrationError {
    if let Some(logger) = logger {
        logger.error(
            "Claude session artifact relocation failed",
            Some(&logger_fields([
                ("operation", Value::String(operation.to_owned())),
                ("error", Value::String(error.to_string())),
            ])),
        );
    }
    transcript_unavailable(
        "Claude session transcript could not be preserved for project-path update",
    )
}

fn copy_support_path(source: &Path, target: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.is_symlink() {
        let link = std::fs::read_link(source)?;
        let directory = source.parent().unwrap_or_else(|| Path::new("."));
        let cwd = std::env::current_dir()?;
        let destination = path::resolve(
            &cwd.to_string_lossy(),
            &[&directory.to_string_lossy(), &link.to_string_lossy()],
        );
        #[cfg(unix)]
        return std::os::unix::fs::symlink(destination, target);
        #[cfg(windows)]
        {
            use std::os::windows::fs::{FileTypeExt, symlink_dir, symlink_file};
            return if metadata.file_type().is_symlink_dir() {
                symlink_dir(destination, target)
            } else {
                symlink_file(destination, target)
            };
        }
    }
    if metadata.is_dir() {
        std::fs::create_dir(target)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_support_path(&entry.path(), &target.join(entry.file_name()))?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Unsupported Claude session support file",
        ));
    }
    std::fs::copy(source, target)?;
    let times = std::fs::FileTimes::new()
        .set_accessed(metadata.accessed()?)
        .set_modified(metadata.modified()?);
    #[cfg(windows)]
    let target_file = {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_WRITE_ATTRIBUTES: u32 = 0x100;
        std::fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .open(target)?
    };
    #[cfg(not(windows))]
    let target_file = std::fs::File::open(target)?;
    target_file.set_times(times)
}

pub async fn prepare_claude_native_session_relocation(
    previous_project_path: &str,
    next_project_path: &str,
    agent_session_id: &str,
    native_path: Option<&str>,
    options: &ClaudeNativePathOptions<'_>,
) -> ExecutorResult<ClaudeNativeSessionRelocation> {
    if !is_safe_session_path_segment(agent_session_id) {
        return Err(transcript_unavailable(OUTSIDE_PROJECT_STATE).into());
    }
    let source_path = resolve_claude_native_path(
        ClaudeNativePathSession {
            project_path: previous_project_path,
            agent_session_id: Some(agent_session_id),
            native_path,
        },
        options,
    )
    .await?
    .ok_or_else(|| {
        transcript_unavailable(
            "Claude session transcript could not be resolved for project-path update",
        )
    })?;
    if config_home_dir_from_native_path(&source_path, agent_session_id).is_none() {
        return Err(transcript_unavailable(OUTSIDE_PROJECT_STATE).into());
    }
    let target_path = create_claude_native_path(next_project_path, agent_session_id, options)
        .await
        .ok_or_else(|| {
            transcript_unavailable("Claude session destination could not be resolved")
        })?;
    let logger = options.logger.clone();
    if source_path == target_path {
        return Ok(ClaudeNativeSessionRelocation {
            native_path: target_path,
            artifacts: None,
            logger,
        });
    }

    let source = session_artifacts(source_path, agent_session_id);
    let target = session_artifacts(target_path.clone(), agent_session_id);
    let prepared: ExecutorResult<()> = async {
        fs::create_dir_all(path::dirname(&target_path)).await?;
        remove_claude_session_artifacts(&target).await?;
        fs::copy(&source.transcript_path, &target.transcript_path).await?;
        if is_file(&source.queue_path).await? {
            fs::copy(&source.queue_path, &target.queue_path).await?;
        }
        if fs::metadata(&source.support_path)
            .await
            .is_ok_and(|metadata| metadata.is_dir())
        {
            let source_support = source.support_path.clone();
            let target_support = target.support_path.clone();
            tokio::task::spawn_blocking(move || {
                copy_support_path(Path::new(&source_support), Path::new(&target_support))
            })
            .await??;
        }
        Ok(())
    }
    .await;
    if let Err(error) = prepared {
        if let Err(cleanup_error) = remove_claude_session_artifacts(&target).await
            && let Some(logger) = &logger
        {
            logger.warn(
                "Claude session relocation rollback failed",
                Some(&logger_fields([
                    ("operation", Value::String("prepare".to_owned())),
                    ("error", Value::String(cleanup_error.to_string())),
                ])),
            );
        }
        return Err(relocation_error(logger.as_deref(), "prepare", error).into());
    }
    Ok(ClaudeNativeSessionRelocation {
        native_path: target_path,
        artifacts: Some((source, target)),
        logger,
    })
}
