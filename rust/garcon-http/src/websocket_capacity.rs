//! Ports browser admission from `server/common/websocket-capacity.ts`.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;

use uuid::Uuid;

pub(crate) struct WebSocketAdmissionController {
    max_connections: usize,
    reservations: RefCell<HashSet<Uuid>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AdmissionRejection {
    HardCapacity,
    DuplicateConnection,
    UnknownReservation,
}

impl AdmissionRejection {
    pub(crate) const fn reason(&self) -> &'static str {
        match self {
            Self::HardCapacity => "hard-capacity",
            Self::DuplicateConnection => "duplicate-connection",
            Self::UnknownReservation => "unknown-reservation",
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("WebSocket maximum must be a positive integer")]
pub(crate) struct InvalidWebSocketCapacity;

pub(crate) struct Reservation {
    id: Uuid,
    admission: Rc<WebSocketAdmissionController>,
}

impl WebSocketAdmissionController {
    pub(crate) fn new(max_connections: usize) -> Result<Rc<Self>, InvalidWebSocketCapacity> {
        if max_connections == 0 {
            return Err(InvalidWebSocketCapacity);
        }
        Ok(Rc::new(Self {
            max_connections,
            reservations: RefCell::new(HashSet::new()),
        }))
    }

    pub(crate) fn try_reserve(
        self: &Rc<Self>,
        id: Uuid,
    ) -> Result<Reservation, AdmissionRejection> {
        let mut ids = self.reservations.borrow_mut();
        if ids.contains(&id) {
            return Err(AdmissionRejection::DuplicateConnection);
        }
        if ids.len() >= self.max_connections {
            return Err(AdmissionRejection::HardCapacity);
        }
        ids.insert(id);
        Ok(Reservation {
            id,
            admission: Rc::clone(self),
        })
    }

    fn confirm(&self, id: Uuid) -> Result<(), AdmissionRejection> {
        if self.reservations.borrow().contains(&id) {
            Ok(())
        } else {
            Err(AdmissionRejection::UnknownReservation)
        }
    }
}

impl Reservation {
    pub(crate) fn id(&self) -> Uuid {
        self.id
    }

    pub(crate) fn confirm(&self) -> Result<(), AdmissionRejection> {
        self.admission.confirm(self.id)
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.admission.reservations.borrow_mut().remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_upgrades_count_toward_the_limit_and_release_their_slot_on_drop() {
        assert!(WebSocketAdmissionController::new(0).is_err());
        let capacity = WebSocketAdmissionController::new(1).unwrap();
        let id = Uuid::from_u128(1);
        let replacement = Uuid::from_u128(2);
        let first = capacity.try_reserve(id).unwrap();
        assert_eq!(first.id(), id);
        assert_eq!(
            capacity.try_reserve(id).err(),
            Some(AdmissionRejection::DuplicateConnection)
        );
        assert_eq!(
            capacity.try_reserve(replacement).err(),
            Some(AdmissionRejection::HardCapacity)
        );
        assert_eq!(first.confirm(), Ok(()));
        drop(first);
        assert_eq!(
            capacity.confirm(id),
            Err(AdmissionRejection::UnknownReservation)
        );
        assert!(capacity.try_reserve(replacement).is_ok());
    }
}
