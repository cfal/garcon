use std::collections::{HashMap, HashSet};

use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::{
    chat_message_coercion::ChatContentMode,
    chat_types::ChatMessage,
    preamble_prefix::{PREAMBLE_OPEN_PREFIX, preamble_prefix_sha256},
};

use crate::{
    imported_drafts::ImportedRow, preamble_history::PreambleHistoryEvidence,
    sqlite_operations::LedgerResult, store::TranscriptReadSignal,
};

pub enum SanitizePreamblePrefixesResult {
    Sanitized(Vec<ImportedRow>),
    NotYetPersisted(&'static str),
    Mismatch(&'static str),
}

type Signature<'a> = (usize, &'a str);

fn signature(entry: &PreambleHistoryEvidence) -> Signature<'_> {
    (entry.receipt.code_unit_length, &entry.receipt.sha256)
}

pub async fn sanitize_recorded_preamble_prefixes(
    mut rows: Vec<ImportedRow>,
    evidence: &[PreambleHistoryEvidence],
    steps: &mut EventLoopSteps,
    signal: TranscriptReadSignal<'_>,
) -> LedgerResult<SanitizePreamblePrefixesResult> {
    use SanitizePreamblePrefixesResult::*;
    if evidence.is_empty() {
        return Ok(Sanitized(rows));
    }
    let mut used = HashSet::new();
    for row in &mut rows {
        signal.check()?;
        steps.next().await;
        let ChatMessage::User(user) = &mut row.message else {
            continue;
        };
        if user.metadata.as_ref().and_then(|meta| meta.content_mode)
            == Some(ChatContentMode::Literal)
            || !user.content.starts_with(PREAMBLE_OPEN_PREFIX)
        {
            continue;
        }
        if !user
            .content
            .split_once('\n')
            .is_some_and(|(frame, _)| frame == "<garcon-preambles version=\"1\">")
        {
            return Ok(Mismatch("unknown preamble frame"));
        }
        let mut matched_signature = None;
        let mut first_unused = None;
        let mut hashes = HashMap::new();
        for (index, candidate) in evidence.iter().enumerate() {
            signal.check()?;
            steps.next().await;
            let (length, expected_hash) = signature(candidate);
            let hash = hashes.entry(length).or_insert_with(|| {
                preamble_prefix_sha256(user.content.encode_utf16().take(length))
            });
            if hash.as_str() != expected_hash {
                continue;
            }
            if matched_signature.is_some_and(|matched| matched != (length, expected_hash)) {
                return Ok(Mismatch("preamble prefix hash mismatch"));
            }
            matched_signature = Some((length, expected_hash));
            if first_unused.is_none() && !used.contains(&index) {
                first_unused = Some(index);
            }
        }
        let Some((length, _)) = matched_signature else {
            return Ok(Mismatch("preamble prefix hash mismatch"));
        };
        let Some(index) = first_unused else {
            return Ok(Mismatch("preamble prefix receipt already consumed"));
        };
        used.insert(index);
        let suffix = user.content.encode_utf16().skip(length).collect::<Vec<_>>();
        user.content = String::from_utf16_lossy(&suffix);
        row.preamble_application = Some(evidence[index].clone());
    }

    let mut counts = HashMap::<_, (usize, usize)>::new();
    for (index, entry) in evidence.iter().enumerate() {
        signal.check()?;
        let count = counts.entry(signature(entry)).or_default();
        count.0 += usize::from(entry.requires_native_occurrence);
        count.1 += usize::from(used.contains(&index));
        steps.next().await;
    }
    for (required, observed) in counts.into_values() {
        signal.check()?;
        if observed < required {
            return Ok(NotYetPersisted(
                "completed preamble turn is absent from native history",
            ));
        }
        steps.next().await;
    }
    signal.check()?;
    Ok(Sanitized(rows))
}
