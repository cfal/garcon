//! Ports `server/runtime/git/pathspecs.ts`.

use std::collections::HashSet;

const MAX_PATHS_PER_GIT_COMMAND: usize = 256;
const MAX_PATHSPEC_BYTES_PER_GIT_COMMAND: usize = 16_000;

pub fn literal_git_pathspec(file_path: &str) -> String {
    format!(":(literal){file_path}")
}

fn glob_pathspec_literal(file_path: &str) -> String {
    let mut escaped = String::with_capacity(file_path.len());
    for ch in file_path.chars() {
        if matches!(ch, '\\' | '*' | '?' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    escaped
}

pub fn exact_git_pathspecs(file_paths: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let paths: Vec<_> = file_paths
        .iter()
        .map(String::as_str)
        .filter(|path| seen.insert(*path))
        .collect();
    let mut result: Vec<_> = paths
        .iter()
        .map(|path| literal_git_pathspec(path))
        .collect();
    result.extend(
        paths
            .iter()
            .filter(|path| {
                let prefix = format!("{path}/");
                !paths.iter().any(|other| other.starts_with(&prefix))
            })
            .map(|path| format!(":(exclude,glob){}/**", glob_pathspec_literal(path))),
    );
    result
}

pub fn chunk_git_pathspecs(paths: &[String]) -> Vec<&[String]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut current_bytes = 0;
    for (index, path) in paths.iter().enumerate() {
        let next_bytes = path.len() + 1;
        if index > start
            && (index - start >= MAX_PATHS_PER_GIT_COMMAND
                || current_bytes + next_bytes > MAX_PATHSPEC_BYTES_PER_GIT_COMMAND)
        {
            chunks.push(&paths[start..index]);
            start = index;
            current_bytes = 0;
        }
        current_bytes += next_bytes;
    }
    if start < paths.len() {
        chunks.push(&paths[start..]);
    }
    chunks
}
