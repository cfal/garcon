//! Ports `server/controller/chats/token-fitting/budget.ts`.

pub use super::tokenx::{estimate_handoff_tokens, estimate_handoff_tokens_utf16};

pub const COMPACTION_QUERY_ATTEMPTS: usize = 2;
const FIT_CORRECTION_MAX_PASSES: u8 = 8;
const FIT_CONVERGENCE_GUARD_TOKENS: f64 = 8.0;

pub fn reduced_compaction_entry_budget(first_entry_budget_tokens: f64) -> f64 {
    (first_entry_budget_tokens * 7.0 / 10.0).floor()
}

pub struct TokenDocumentBudget {
    pub usable_tokens: f64,
    pub fixed_frame_tokens: f64,
    pub maximum_entry_budget_tokens: Option<f64>,
    pub minimum_entry_budget_tokens: Option<f64>,
}

pub struct FittedTokenDocument<T> {
    pub value: T,
    pub estimated_tokens: usize,
    pub entry_budget_tokens: f64,
    pub correction_passes: u8,
}

pub fn fit_estimated_token_document<T>(
    budget: TokenDocumentBudget,
    mut render: impl FnMut(f64) -> Option<T>,
    mut document: impl FnMut(&T) -> &str,
    mut admitted_entry_cost: impl FnMut(&T) -> Option<f64>,
) -> Option<FittedTokenDocument<T>> {
    let minimum_entry_budget = budget.minimum_entry_budget_tokens.unwrap_or(1.0);
    let available_entry_budget = budget.usable_tokens - budget.fixed_frame_tokens;
    let mut entry_budget = js_min(
        available_entry_budget,
        budget
            .maximum_entry_budget_tokens
            .unwrap_or(available_entry_budget),
    );
    if entry_budget < minimum_entry_budget {
        return None;
    }

    let mut correction_passes = 0;
    let mut forced_attempt_pending = false;
    let mut minimum_bridge_attempted = false;
    let mut minimum_bridge_pending = false;
    while correction_passes < FIT_CORRECTION_MAX_PASSES || forced_attempt_pending {
        let rendered_at_minimum_bridge = minimum_bridge_pending;
        minimum_bridge_pending = false;
        let value = render(entry_budget)?;
        correction_passes += 1;
        let estimated_tokens = estimate_handoff_tokens(document(&value));
        if estimated_tokens as f64 <= budget.usable_tokens {
            return Some(FittedTokenDocument {
                value,
                estimated_tokens,
                entry_budget_tokens: entry_budget,
                correction_passes,
            });
        }
        if entry_budget == minimum_entry_budget {
            return None;
        }
        if rendered_at_minimum_bridge {
            entry_budget = minimum_entry_budget;
            forced_attempt_pending = true;
            continue;
        }
        let overflow_correction = entry_budget
            - (estimated_tokens as f64 - budget.usable_tokens + FIT_CONVERGENCE_GUARD_TOKENS);
        let admission_threshold = admitted_entry_cost(&value).map(|cost| cost.ceil() - 1.0);
        let corrected = admission_threshold.map_or(overflow_correction, |threshold| {
            js_min(overflow_correction, threshold)
        });
        if corrected <= minimum_entry_budget && !minimum_bridge_attempted {
            let damped = js_min(
                ((entry_budget + minimum_entry_budget) / 2.0).floor(),
                admission_threshold.unwrap_or(entry_budget - 1.0),
            );
            if damped > minimum_entry_budget {
                entry_budget = damped;
                minimum_bridge_attempted = true;
                minimum_bridge_pending = true;
                forced_attempt_pending = true;
                continue;
            }
        }
        entry_budget = -js_min(-minimum_entry_budget, -corrected);
        forced_attempt_pending = entry_budget == minimum_entry_budget;
    }
    None
}

fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 && (a.is_sign_negative() || b.is_sign_negative()) {
        -0.0
    } else {
        a.min(b)
    }
}
