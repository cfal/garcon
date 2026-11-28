//! Ports `server/runtime/git/diff-file-list.ts`.

use garcon_contract::git::DiffStats;
use garcon_js::{Number, array_index, parse_int};
use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

pub type NumstatMap = IndexMap<String, DiffStats>;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDiffFile {
    pub path: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub additions: Number,
    pub deletions: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_binary: Option<bool>,
}

fn stat_number(value: &str) -> Number {
    Number(
        parse_int(value, 10)
            .filter(|n| *n != 0.0)
            .unwrap_or_default(),
    )
}

pub fn parse_numstat_z(numstat_output: &str) -> NumstatMap {
    let mut stats = NumstatMap::new();
    let mut tokens = numstat_output.split('\0');
    while let Some(token) = tokens.next() {
        let mut fields = token.splitn(3, '\t');
        let (Some(additions_raw), Some(deletions_raw), Some(path_part)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let is_binary = additions_raw == "-" || deletions_raw == "-";
        let additions = if is_binary {
            Number(0.0)
        } else {
            stat_number(additions_raw)
        };
        let deletions = if is_binary {
            Number(0.0)
        } else {
            stat_number(deletions_raw)
        };
        let path = if path_part.is_empty() {
            let original = tokens.next();
            tokens.next().or(original).unwrap_or_default()
        } else {
            path_part
        };
        if !path.is_empty() {
            stats.insert(
                path.into(),
                DiffStats {
                    additions,
                    deletions,
                    is_binary: is_binary.then_some(true),
                },
            );
        }
    }
    if stats.keys().any(|key| array_index(key).is_some()) {
        stats.sort_by(|left, _, right, _| {
            array_index(left)
                .unwrap_or(u64::MAX)
                .cmp(&array_index(right).unwrap_or(u64::MAX))
        });
    }
    stats
}

pub fn parse_name_status_z(output: &str, stats: &NumstatMap) -> Vec<ParsedDiffFile> {
    let mut tokens = output.strip_suffix('\0').unwrap_or(output).split('\0');
    let mut files = Vec::new();
    while let Some(status) = tokens.next() {
        if status.is_empty() {
            continue;
        }
        let original_path = if status.starts_with(['R', 'C']) {
            tokens
                .next()
                .filter(|path| !path.is_empty())
                .map(str::to_owned)
        } else {
            None
        };
        let Some(path) = tokens.next().filter(|path| !path.is_empty()) else {
            continue;
        };
        let file_stats = stats.get(path);
        files.push(ParsedDiffFile {
            path: path.into(),
            status: status.into(),
            original_path,
            additions: file_stats.map_or(Number(0.0), |entry| entry.additions),
            deletions: file_stats.map_or(Number(0.0), |entry| entry.deletions),
            is_binary: file_stats
                .and_then(|entry| entry.is_binary)
                .filter(|flag| *flag),
        });
    }
    files
}

pub fn parse_unmerged_paths(output: &str) -> IndexSet<&str> {
    output
        .split('\0')
        .filter_map(|token| token.split_once('\t').map(|(_, path)| path))
        .filter(|path| !path.is_empty())
        .collect()
}
