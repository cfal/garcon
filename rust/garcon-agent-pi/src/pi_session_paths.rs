//! Ports `server-agents/pi/src/agents/pi/pi-session-paths.ts`.

use std::{error::Error, io, sync::LazyLock};

use futures::{TryStreamExt, pin_mut};
use garcon_agents_common::shared::history_loader_utils::{
    JsonlLineReadOptions, read_jsonl_line_entries,
};
use garcon_base::errors::{ErrorInput, has_node_error_code};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{json::from_str, path::native};
use regex::Regex;
use serde_json::Value;
use tokio::fs;
use url::Url;

use crate::{config::PiConfig, session_projection::truthy};

static NATIVE_NAME: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the pattern is static.
    Regex::new(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9-]+Z_([^\r\n\x{2028}\x{2029}]+)\.jsonl$")
        .expect("native Pi session filename")
});

pub fn native_pi_windows_path(value: &str) -> String {
    if value.contains('\\') {
        return value.to_owned();
    }
    let Some(mut path) = value.strip_prefix('/') else {
        return value.to_owned();
    };
    for prefix in ["mnt/", "cygdrive/"] {
        if path
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        {
            path = &path[prefix.len()..];
            break;
        }
    }
    let (drive, rest) = path.split_once('/').unwrap_or((path, ""));
    if drive.len() != 1
        || !drive.as_bytes()[0].is_ascii_alphabetic()
        || rest.contains(['\r', '\n', '\u{2028}', '\u{2029}'])
    {
        return value.to_owned();
    }
    format!(
        "{}:\\{}",
        drive.to_ascii_uppercase(),
        rest.replace('/', "\\")
    )
}

fn resolve_pi_path(value: &str, cwd: &str, home: &str) -> ExecutorResult<String> {
    let normalized;
    let value = if cfg!(windows) {
        normalized = native_pi_windows_path(value);
        normalized.as_str()
    } else {
        value
    };
    if value == "~" {
        return Ok(native::resolve(cwd, &[home]));
    }
    if let Some(rest) = value.strip_prefix("~/").or_else(|| {
        if cfg!(windows) {
            value.strip_prefix("~\\")
        } else {
            None
        }
    }) {
        return Ok(native::resolve(cwd, &[&native::join(&[home, rest])]));
    }
    if value.starts_with("file://") {
        let url = Url::parse(value)?;
        let encoded_path = url.path().to_ascii_lowercase();
        if encoded_path.contains("%2f") || (cfg!(windows) && encoded_path.contains("%5c")) {
            return Err("File URL path must not include encoded separator characters".into());
        }
        let path = url.to_file_path().map_err(|()| "Invalid Pi file URL")?;
        return Ok(native::resolve(cwd, &[&path.to_string_lossy()]));
    }
    Ok(native::resolve(cwd, &[value]))
}

fn same_pi_path(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

async fn session_dir_setting(file: &str) -> ExecutorResult<Option<String>> {
    let Ok(raw) = fs::read(file).await else {
        return Ok(None);
    };
    let text = String::from_utf8_lossy(&raw);
    let Ok(settings) = from_str::<Value>(text.strip_prefix('\u{feff}').unwrap_or(&text)) else {
        return Ok(None);
    };
    match settings.get("sessionDir") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(String::new())),
        Some(Value::String(directory)) => Ok(Some(directory.to_owned())),
        _ => Err("Invalid Pi session directory settings.".into()),
    }
}

pub async fn canonical_existing_pi_session_path(value: &str) -> ExecutorResult<Option<String>> {
    if !native::is_absolute(value) {
        return Ok(None);
    }
    let file = async {
        if fs::metadata(value).await?.is_file() {
            Ok::<_, io::Error>(Some(native::normalize(
                &fs::canonicalize(value).await?.to_string_lossy(),
            )))
        } else {
            Ok(None)
        }
    }
    .await;
    match file {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        file => file.map_err(Into::into),
    }
}

// Pi selects the session directory before resolving trust or loading extensions.
// https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/main.ts#L735-L744
pub async fn find_pi_session_file_by_session_id(
    session_id: &str,
    project_path: &str,
    config: &PiConfig,
) -> ExecutorResult<Option<String>> {
    if session_id.is_empty() || project_path.is_empty() {
        return Ok(None);
    }
    let home = config.home_directory()?;
    let cwd = std::env::current_dir()?;
    let cwd = cwd.to_string_lossy();
    let selected_project = resolve_pi_path(project_path, &cwd, &home)?;
    let project = fs::canonicalize(&selected_project).await.map_or_else(
        |_| selected_project.clone(),
        |path| path.to_string_lossy().into_owned(),
    );
    let agent_dir = resolve_pi_path(
        &config
            .agent_directory_override()?
            .unwrap_or_else(|| native::join(&[&home, ".pi", "agent"])),
        &project,
        &home,
    )?;
    let mut configured = config.session_directory_override()?;
    if configured.is_none() {
        configured =
            session_dir_setting(&native::join(&[&project, ".pi", "settings.json"])).await?;
    }
    if configured.is_none() {
        configured = session_dir_setting(&native::join(&[&agent_dir, "settings.json"])).await?;
    }

    let sessions_root = native::join(&[&agent_dir, "sessions"]);
    let local = format!(
        "--{}--",
        project
            .strip_prefix(['/', '\\'])
            .unwrap_or(&project)
            .replace(['/', '\\', ':'], "-")
    );
    let local_dir = native::join(&[&sessions_root, &local]);
    if let Some(path) = configured.filter(|path| !path.is_empty()) {
        let directory = resolve_pi_path(&path, &project, &home)?;
        return find_in_directory(&directory, session_id, |recorded_cwd| {
            if same_pi_path(&directory, &local_dir) {
                return Ok(true);
            }
            let Some(recorded) = recorded_cwd.as_str().filter(|cwd| !cwd.is_empty()) else {
                return Ok(false);
            };
            let recorded = resolve_pi_path(recorded, &cwd, &home)?;
            Ok(same_pi_path(&recorded, &project) || same_pi_path(&recorded, &selected_project))
        })
        .await;
    }
    if let Some(nearby) = find_in_directory(&local_dir, session_id, |_| Ok(true)).await? {
        return Ok(Some(nearby));
    }
    let Some(mut entries) = directory_entries(&sessions_root).await? else {
        return Ok(None);
    };
    let mut matched: Option<String> = None;
    let mut access_error = None;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let kind = entry.file_type().await?;
        if name == local || (!kind.is_dir() && !kind.is_symlink()) {
            continue;
        }
        let before = find_in_directory(&native::join(&[&sessions_root, &name]), session_id, |_| {
            Ok(true)
        })
        .await;
        let candidate = match before {
            Ok(Some(candidate)) => candidate,
            Ok(None) => continue,
            Err(error) => {
                let input = ErrorInput::Error(error.as_ref());
                if kind.is_symlink()
                    && (has_node_error_code(input, "ENOTDIR")
                        || has_node_error_code(input, "ELOOP"))
                {
                    continue;
                }
                if has_node_error_code(input, "EACCES") || has_node_error_code(input, "EPERM") {
                    access_error.get_or_insert(error);
                    continue;
                }
                return Err(error);
            }
        };
        if let Some(previous) = &matched {
            let previous = fs::canonicalize(previous).await?;
            let candidate = fs::canonicalize(&candidate).await?;
            if !same_pi_path(&previous.to_string_lossy(), &candidate.to_string_lossy()) {
                return Err("Pi transcript discovery found duplicate session IDs".into());
            }
        } else {
            matched = Some(candidate);
        }
    }
    if matched.is_none()
        && let Some(error) = access_error
    {
        return Err(error);
    }
    Ok(matched)
}

async fn directory_entries(directory: &str) -> io::Result<Option<fs::ReadDir>> {
    match fs::read_dir(directory).await {
        Ok(entries) => Ok(Some(entries)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

async fn read_session_header(file: &str) -> ExecutorResult<Value> {
    let mut parse_error = None;
    // Only the first parsed, nonempty entry establishes a file's identity.
    let entries = read_jsonl_line_entries(
        file,
        JsonlLineReadOptions {
            max_read_bytes: Some(1024 * 1024),
            ..Default::default()
        },
    );
    pin_mut!(entries);
    while let Some(entry) = entries.try_next().await? {
        match from_str::<Value>(&entry.line) {
            Ok(value) if truthy(&value) => return Ok(value),
            Ok(_) => {}
            Err(error) => {
                parse_error.get_or_insert(error);
            }
        }
    }
    match parse_error {
        Some(error) => Err(error.into()),
        None => Ok(Value::Null),
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Pi transcript header could not be read")]
struct UnreadablePiHeader(#[source] Box<dyn Error>);

async fn find_in_directory(
    directory: &str,
    session_id: &str,
    matches_project: impl Fn(&Value) -> ExecutorResult<bool>,
) -> ExecutorResult<Option<String>> {
    let Some(mut entries) = directory_entries(directory).await? else {
        return Ok(None);
    };
    let mut matched = None;
    let suffix = format!("_{session_id}.jsonl");
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".jsonl") {
            continue;
        }
        let named = NATIVE_NAME.captures(&name).map_or_else(
            || name.ends_with(&suffix),
            |captures| &captures[1] == session_id,
        );
        if !entry.file_type().await?.is_file() {
            if named {
                return Err("Pi transcript source is not a regular file".into());
            }
            continue;
        }
        let candidate = native::join(&[directory, &name]);
        let header = match read_session_header(&candidate).await {
            Ok(header) => header,
            Err(error) if named => return Err(UnreadablePiHeader(error).into()),
            Err(_) => continue,
        };
        if header["type"] != "session" || header["id"] != session_id {
            if named {
                return Err("Pi transcript header does not match the selected session".into());
            }
            continue;
        }
        if !matches_project(&header["cwd"])? {
            continue;
        }
        if matched.replace(candidate).is_some() {
            return Err("Pi transcript discovery found duplicate session files".into());
        }
    }
    Ok(matched)
}
