use std::collections::HashSet;

use garcon_js::{Number, is_integer};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WebSocketAdmissionRejection {
    HardCapacity,
    DuplicateConnection,
    UnknownReservation,
}

#[derive(Debug, thiserror::Error)]
#[error("WebSocket maximum must be a positive integer")]
pub struct InvalidWebSocketCapacity;

pub struct WebSocketAdmissionController {
    pub max_connections: Number,
    reservations: HashSet<String>,
}

impl WebSocketAdmissionController {
    pub fn new(max_connections: f64) -> Result<Self, InvalidWebSocketCapacity> {
        if !is_integer(max_connections) || max_connections < 1.0 {
            return Err(InvalidWebSocketCapacity);
        }
        Ok(Self {
            max_connections: Number(max_connections),
            reservations: HashSet::new(),
        })
    }

    pub fn size(&self) -> usize {
        self.reservations.len()
    }

    pub fn try_reserve(&mut self, connection_id: &str) -> Result<(), WebSocketAdmissionRejection> {
        if self.reservations.contains(connection_id) {
            return Err(WebSocketAdmissionRejection::DuplicateConnection);
        }
        if self.size() as f64 >= self.max_connections.0 {
            return Err(WebSocketAdmissionRejection::HardCapacity);
        }
        self.reservations.insert(connection_id.into());
        Ok(())
    }

    pub fn confirm(&self, connection_id: &str) -> Result<(), WebSocketAdmissionRejection> {
        if !self.reservations.contains(connection_id) {
            return Err(WebSocketAdmissionRejection::UnknownReservation);
        }
        Ok(())
    }

    pub fn release(&mut self, connection_id: &str) -> bool {
        self.reservations.remove(connection_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use WebSocketAdmissionRejection::*;

    #[test]
    fn admits_primary_sockets_up_to_the_hard_limit() {
        let mut admission = WebSocketAdmissionController::new(2.0).unwrap();
        assert_eq!(admission.try_reserve("socket-1"), Ok(()));
        assert_eq!(admission.try_reserve("socket-2"), Ok(()));
        assert_eq!(admission.try_reserve("socket-3"), Err(HardCapacity));
        assert_eq!(admission.try_reserve("socket-1"), Err(DuplicateConnection));
    }

    #[test]
    fn tracks_pending_and_active_reservations_with_exact_release_semantics() {
        let mut admission = WebSocketAdmissionController::new(3.0).unwrap();
        assert_eq!(admission.try_reserve("socket-1"), Ok(()));
        assert_eq!(admission.try_reserve("socket-1"), Err(DuplicateConnection));
        assert_eq!(admission.confirm("missing"), Err(UnknownReservation));
        assert_eq!(admission.confirm("socket-1"), Ok(()));
        assert_eq!(admission.confirm("socket-1"), Ok(()));
        assert_eq!(admission.try_reserve("socket-1"), Err(DuplicateConnection));
        assert_eq!(admission.size(), 1);
        assert!(admission.release("socket-1"));
        assert_eq!(admission.confirm("socket-1"), Err(UnknownReservation));
    }

    #[test]
    fn releases_failed_upgrades_so_later_reservations_can_proceed() {
        let mut admission = WebSocketAdmissionController::new(1.0).unwrap();
        assert_eq!(admission.try_reserve("failed"), Ok(()));
        assert!(admission.release("failed"));
        assert_eq!(admission.try_reserve("next"), Ok(()));
        assert_eq!(admission.confirm("next"), Ok(()));
        assert!(admission.release("next"));
        assert!(!admission.release("next"));
    }

    #[test]
    fn rejects_invalid_capacity_limits() {
        for limit in [0.0, f64::NAN, -1.0, 1.5, f64::INFINITY] {
            assert!(WebSocketAdmissionController::new(limit).is_err());
        }
        assert!(WebSocketAdmissionController::new(1e21).is_ok());
    }
}
