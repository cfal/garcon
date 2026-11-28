//! Ports `server/runtime/git/porcelain-status.ts`.

use garcon_contract::git::GitChangeKind;
use garcon_js::utf16;
use serde::Serialize;

pub const UNMERGED_STATUSES: &[&str] = &["UU", "AA", "DD", "AU", "UA", "DU", "UD"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PorcelainStatusEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub index_status: char,
    pub work_tree_status: char,
}

pub fn change_kind_for_status(status: &str) -> GitChangeKind {
    match status {
        "A" => GitChangeKind::Added,
        "D" => GitChangeKind::Deleted,
        "R" | "C" => GitChangeKind::Renamed,
        "?" => GitChangeKind::Untracked,
        _ => GitChangeKind::Modified,
    }
}

pub fn has_index_change(status: &str) -> bool {
    !matches!(status, "" | " " | "?" | "!")
}

pub fn has_work_tree_change(status: &str) -> bool {
    !matches!(status, "" | " " | "!")
}

fn status_column(token: &str, offset: usize) -> char {
    utf16::char_code_at(token, offset).map_or(' ', |unit| {
        char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER)
    })
}

fn porcelain_path(token: &str) -> String {
    let tail = utf16::slice(token, 3, None);
    if utf16::char_code_at(token, 3).is_some_and(|unit| (0xDC00..=0xDFFF).contains(&unit)) {
        // The slice starts between two UTF-16 units of one character.
        format!("\u{FFFD}{tail}")
    } else {
        tail.into()
    }
}

pub fn parse_porcelain_v1_z(output: &str) -> Vec<PorcelainStatusEntry> {
    let mut tokens = output.split('\0').filter(|token| !token.is_empty());
    let mut entries = Vec::new();
    while let Some(token) = tokens.next() {
        let index_status = status_column(token, 0);
        let work_tree_status = status_column(token, 1);
        let path = porcelain_path(token);
        let original_path = (matches!(index_status, 'R' | 'C')
            || matches!(work_tree_status, 'R' | 'C'))
        .then(|| tokens.next().unwrap_or_default().to_owned());
        entries.push(PorcelainStatusEntry {
            path,
            original_path,
            index_status,
            work_tree_status,
        });
    }
    entries
}
