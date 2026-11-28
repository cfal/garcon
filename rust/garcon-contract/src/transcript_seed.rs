//! Ports `common/transcript-seed.ts`.
//!
//! The wire types and receipt helpers are independent of transcript messages.
//! The projection and sanitation slice waits for the full `ChatMessage` contract,
//! including notices. That slice will add:
//! `createCarryoverTranscript`, `createCarryoverTranscriptWithinCost`,
//! `renderCarriedContext`, `retargetNativeSeedReceiptIfPreserved`,
//! `sanitizeRecordedCarriedContext`, `renderTranscriptSeed`, `isProjectableMessage`,
//! `isPublicationGapMessage`, `boundProjectedMessage`, and `projectToolUseSummary`,
//! with `ProjectionCostBudget`, `SanitizeCarriedContextResult`, and `ProjectedToolUseSummary`.

use garcon_js::{is_safe_integer, json::as_number, utf16};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const SEED_CONTEXT_OPEN: &str = "<carried-context>";
pub const SEED_CONTEXT_CLOSE: &str = "</carried-context>";
pub const CARRIED_CONTEXT_VERSION: u8 = 3;
pub const CARRYOVER_INJECTION_MAX_CHARS: usize = 250_000;
pub const RECENT_TURNS_VERBATIM: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSeedReceipt {
    pub agent_session_id: String,
    pub placement: NativeSeedPlacement,
    pub format: NativeSeedFormat,
    pub code_unit_length: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeSeedPlacement {
    UserPrefix,
    ProviderContext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NativeSeedFormat {
    V3Xml,
    V2Xml,
    V1Marker,
    LegacyV0,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CarriedContext {
    pub prefix: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary_truncated: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostedCarriedContext {
    #[serde(flatten)]
    pub context: CarriedContext,
    pub admission_cost: garcon_js::Number,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
#[error("Native seed receipt session ID is required")]
pub struct MissingNativeSeedSessionId;

pub struct NativeSeedReceiptInput<'a> {
    pub agent_session_id: &'a str,
    pub placement: NativeSeedPlacement,
    pub prefix: &'a str,
    pub format: Option<NativeSeedFormat>,
}

fn sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub fn create_native_seed_receipt(
    input: NativeSeedReceiptInput<'_>,
) -> Result<NativeSeedReceipt, MissingNativeSeedSessionId> {
    if input.agent_session_id.is_empty() {
        return Err(MissingNativeSeedSessionId);
    }
    Ok(NativeSeedReceipt {
        agent_session_id: input.agent_session_id.to_owned(),
        placement: input.placement,
        format: input.format.unwrap_or(NativeSeedFormat::V3Xml),
        code_unit_length: utf16::len(input.prefix) as u64,
        sha256: sha256(input.prefix),
    })
}

pub fn receipt_for_carried_context(
    carried_context: Option<&CarriedContext>,
    agent_session_id: &str,
    placement: Option<NativeSeedPlacement>,
) -> Result<Option<NativeSeedReceipt>, MissingNativeSeedSessionId> {
    carried_context
        .map(|context| {
            create_native_seed_receipt(NativeSeedReceiptInput {
                agent_session_id,
                placement: placement.unwrap_or(NativeSeedPlacement::UserPrefix),
                prefix: &context.prefix,
                format: None,
            })
        })
        .transpose()
}

pub fn retarget_native_seed_receipt(
    receipt: Option<&NativeSeedReceipt>,
    agent_session_id: &str,
) -> Result<Option<NativeSeedReceipt>, MissingNativeSeedSessionId> {
    let Some(receipt) = receipt else {
        return Ok(None);
    };
    if agent_session_id.is_empty() {
        return Err(MissingNativeSeedSessionId);
    }
    Ok(Some(NativeSeedReceipt {
        agent_session_id: agent_session_id.to_owned(),
        ..receipt.clone()
    }))
}

pub fn parse_native_seed_receipt(value: &Value) -> Option<NativeSeedReceipt> {
    let receipt = value.as_object()?;
    let agent_session_id = receipt
        .get("agentSessionId")?
        .as_str()
        .filter(|text| !text.is_empty())?;
    let placement = match receipt.get("placement")?.as_str()? {
        "user-prefix" => NativeSeedPlacement::UserPrefix,
        "provider-context" => NativeSeedPlacement::ProviderContext,
        _ => return None,
    };
    let format = match receipt.get("format")?.as_str()? {
        "v3-xml" => NativeSeedFormat::V3Xml,
        "v2-xml" => NativeSeedFormat::V2Xml,
        "v1-marker" => NativeSeedFormat::V1Marker,
        "legacy-v0" => NativeSeedFormat::LegacyV0,
        _ => return None,
    };
    let code_unit_length = as_number(receipt.get("codeUnitLength")?)?;
    if !is_safe_integer(code_unit_length) || code_unit_length < 0.0 {
        return None;
    }
    let sha256 = receipt.get("sha256")?.as_str()?;
    if utf16::len(sha256) != 64
        || !sha256
            .bytes()
            .all(|unit| unit.is_ascii_digit() || (b'a'..=b'f').contains(&unit))
    {
        return None;
    }
    Some(NativeSeedReceipt {
        agent_session_id: agent_session_id.to_owned(),
        placement,
        format,
        code_unit_length: code_unit_length as u64,
        sha256: sha256.to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn receipt_counts_utf16_for_astral_characters() {
        let receipt = create_native_seed_receipt(NativeSeedReceiptInput {
            agent_session_id: "source",
            placement: NativeSeedPlacement::UserPrefix,
            prefix: "\u{1f642}",
            format: None,
        })
        .unwrap();
        assert_eq!(receipt.code_unit_length, 2);
        assert_eq!(receipt.format, NativeSeedFormat::V3Xml);
        assert_eq!(
            parse_native_seed_receipt(&serde_json::to_value(&receipt).unwrap()),
            Some(receipt)
        );
    }

    #[test]
    fn retargets_a_receipt_without_replacing_its_hash() {
        let receipt = receipt_for_carried_context(
            Some(&CarriedContext {
                prefix: "Synthetic".into(),
                summary_truncated: Some(true),
            }),
            "source",
            Some(NativeSeedPlacement::ProviderContext),
        )
        .unwrap()
        .unwrap();
        let target = retarget_native_seed_receipt(Some(&receipt), "target")
            .unwrap()
            .unwrap();
        assert_eq!(
            target,
            NativeSeedReceipt {
                agent_session_id: "target".into(),
                ..receipt.clone()
            }
        );
        assert_eq!(
            retarget_native_seed_receipt(Some(&receipt), ""),
            Err(MissingNativeSeedSessionId)
        );
        assert_eq!(retarget_native_seed_receipt(None, ""), Ok(None));
    }
}
