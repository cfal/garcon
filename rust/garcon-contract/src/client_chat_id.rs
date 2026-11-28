//! Monotonic client-issued chat identifiers.

use std::cell::RefCell;

use garcon_js::{Clock, SystemClock, performance_now_ms, performance_time_origin_ms};
use serde_json::Value;

use crate::chat_id::{ChatId, InvalidChatIdError, parse_chat_id};

const MIN_CANONICAL_EPOCH_MS: f64 = 1_000_000_000_000.0;
const MAX_SAFE_EPOCH_MS: f64 = 9_007_199_254_740_991.0 / 1_000.0;

#[derive(Default)]
pub struct ClientChatIdGenerator {
    last_issued: i128,
}

impl ClientChatIdGenerator {
    pub fn create(
        &mut self,
        observed_performance_ms: Option<f64>,
        wall_clock: &dyn Clock,
    ) -> Result<ChatId, InvalidChatIdError> {
        let observed = match observed_performance_ms {
            Some(ms) if (MIN_CANONICAL_EPOCH_MS..=MAX_SAFE_EPOCH_MS).contains(&ms) => {
                let epoch_ms = ms.floor();
                (epoch_ms as i128) * 1000 + ((ms - epoch_ms) * 1000.0).floor() as i128
            }
            _ => i128::from(wall_clock.now_ms()) * 1000,
        };
        let next = observed.max(self.last_issued + 1);
        let id = parse_chat_id(&Value::String(next.to_string()))?;
        self.last_issued = next;
        Ok(id)
    }
}

thread_local! {
    static GENERATOR: RefCell<ClientChatIdGenerator> = const {
        RefCell::new(ClientChatIdGenerator { last_issued: 0 })
    };
}

pub fn create_client_chat_id() -> Result<ChatId, InvalidChatIdError> {
    GENERATOR.with_borrow_mut(|generator| {
        generator.create(
            Some(performance_time_origin_ms() + performance_now_ms()),
            &SystemClock,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_js::ManualClock;

    #[test]
    fn preserves_performance_precision_and_increments_through_a_clock_reversal() {
        let clock = ManualClock::new(1_600_000_000_000);
        let mut generator = ClientChatIdGenerator::default();
        let observed = 1_700_000_000_000.25;
        assert_eq!(
            generator.create(Some(observed), &clock).unwrap().as_str(),
            "1700000000000250"
        );
        assert_eq!(
            generator
                .create(Some(observed - 1.0), &clock)
                .unwrap()
                .as_str(),
            "1700000000000251"
        );
    }

    #[test]
    fn falls_back_for_unavailable_or_non_unix_performance_clocks() {
        let clock = ManualClock::new(1_600_000_000_000);
        for observed in [None, Some(12.0), Some(f64::NAN), Some(f64::INFINITY)] {
            let id = ClientChatIdGenerator::default()
                .create(observed, &clock)
                .unwrap();
            assert_eq!(id.as_str(), "1600000000000000");
        }
    }

    #[test]
    fn a_rejected_id_does_not_advance_the_next_issue() {
        let clock = ManualClock::new(i64::MAX);
        let mut generator = ClientChatIdGenerator::default();
        assert!(generator.create(None, &clock).is_err());
        clock.set(1_600_000_000_000);
        assert_eq!(
            generator.create(None, &clock).unwrap().as_str(),
            "1600000000000000"
        );
    }
}
