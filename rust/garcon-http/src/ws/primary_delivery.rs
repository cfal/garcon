//! Browser peer ownership and the post-send limit of `primary-delivery.ts`.

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use bytes::Bytes;
use indexmap::IndexMap;
use uuid::Uuid;

use crate::websocket_auth::{BrowserClose, BrowserPrincipal};
use crate::websocket_capacity::Reservation;

use super::transport::{PrimaryTransport, SendResult};

const SERVER_SHUTTING_DOWN: BrowserClose = BrowserClose {
    code: 1001,
    reason: "Server shutting down",
};

pub(crate) struct PrimaryPeer {
    pub(crate) principal: BrowserPrincipal,
    transport: Rc<dyn PrimaryTransport>,
    reservation: RefCell<Option<Reservation>>,
    topics: RefCell<HashSet<String>>,
    budget: usize,
}

impl PrimaryPeer {
    pub(crate) fn is_open(&self) -> bool {
        self.reservation.borrow().is_some()
    }

    pub(crate) fn subscribe(&self, topic: &str) -> bool {
        if !self.is_open() {
            return false;
        }
        self.topics.borrow_mut().insert(topic.into());
        true
    }

    pub(crate) fn send(&self, payload: Bytes) -> SendResult {
        if !self.is_open() {
            return SendResult::Dropped;
        }
        let result = self.transport.send(payload);
        if self.transport.buffered_amount() > self.budget {
            self.retire();
            self.transport.terminate();
            return SendResult::Dropped;
        }
        if result == SendResult::Dropped {
            self.retire();
        }
        result
    }

    fn retire(&self) -> bool {
        self.reservation.borrow_mut().take().is_some()
    }

    pub(crate) fn close(&self, close: BrowserClose) {
        if self.retire() {
            self.transport.close(close);
        }
    }
}

pub(crate) struct PrimarySocketDelivery {
    peers: RefCell<IndexMap<Uuid, Rc<PrimaryPeer>>>,
    closed: Cell<bool>,
    budget: usize,
}

impl PrimarySocketDelivery {
    pub(crate) fn new(budget: usize) -> Self {
        Self {
            peers: RefCell::new(IndexMap::new()),
            closed: Cell::new(false),
            budget,
        }
    }

    pub(crate) fn add(
        &self,
        reservation: Reservation,
        principal: BrowserPrincipal,
        transport: Rc<dyn PrimaryTransport>,
    ) -> Rc<PrimaryPeer> {
        let id = reservation.id();
        let peer = Rc::new(PrimaryPeer {
            principal,
            transport,
            reservation: RefCell::new(Some(reservation)),
            topics: RefCell::new(HashSet::new()),
            budget: self.budget,
        });
        if self.closed.get() {
            peer.close(SERVER_SHUTTING_DOWN);
        } else {
            self.peers.borrow_mut().insert(id, Rc::clone(&peer));
        }
        peer
    }

    pub(crate) fn remove(&self, id: Uuid) -> Option<Rc<PrimaryPeer>> {
        let peer = self.peers.borrow_mut().shift_remove(&id)?;
        peer.retire();
        Some(peer)
    }

    pub(crate) fn close(&self) {
        self.closed.set(true);
        self.retire_where(|_| Some(SERVER_SHUTTING_DOWN));
    }

    pub(crate) fn retire_where(
        &self,
        reason: impl Fn(&BrowserPrincipal) -> Option<BrowserClose>,
    ) -> usize {
        let mut retired = Vec::new();
        self.peers.borrow_mut().retain(|_, peer| {
            let Some(close) = reason(&peer.principal) else {
                return true;
            };
            if peer.retire() {
                retired.push((Rc::clone(peer), close));
            }
            false
        });
        // Retire the entire set before any socket begins its close handshake.
        for (peer, close) in &retired {
            peer.transport.close(*close);
        }
        retired.len()
    }

    pub(crate) fn publish(&self, topic: &str, payload: &Bytes) -> isize {
        let mut sent = 0_isize;
        let mut queued = false;
        for peer in self.peers.borrow().values() {
            if !peer.topics.borrow().contains(topic) {
                continue;
            }
            match peer.send(payload.clone()) {
                SendResult::Sent(bytes) => {
                    sent = sent.saturating_add(isize::try_from(bytes).unwrap_or(isize::MAX))
                }
                SendResult::Queued => queued = true,
                SendResult::Dropped => {}
            }
        }
        if sent != 0 {
            sent
        } else if queued {
            -1
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::websocket_capacity::WebSocketAdmissionController;

    #[derive(Default)]
    struct FixtureWire {
        buffered: Cell<usize>,
        immediate: Cell<bool>,
        terminated: Cell<bool>,
        deliveries: RefCell<Vec<Bytes>>,
        close: Cell<Option<BrowserClose>>,
        on_close: RefCell<Option<Box<dyn FnOnce()>>>,
    }

    impl PrimaryTransport for FixtureWire {
        fn send(&self, payload: Bytes) -> SendResult {
            self.deliveries.borrow_mut().push(payload.clone());
            if self.immediate.get() {
                return SendResult::Sent(payload.len());
            }
            self.buffered.set(self.buffered.get() + payload.len());
            SendResult::Queued
        }
        fn buffered_amount(&self) -> usize {
            self.buffered.get()
        }
        fn close(&self, close: BrowserClose) {
            self.close.set(Some(close));
            if let Some(on_close) = self.on_close.borrow_mut().take() {
                on_close();
            }
        }
        fn terminate(&self) {
            self.terminated.set(true);
        }
    }

    fn attach(
        delivery: &PrimarySocketDelivery,
        admission: &Rc<WebSocketAdmissionController>,
        id: u128,
    ) -> (Rc<PrimaryPeer>, Rc<FixtureWire>) {
        let transport = Rc::new(FixtureWire::default());
        let slot = admission.try_reserve(Uuid::from_u128(id)).unwrap();
        let peer = delivery.add(slot, BrowserPrincipal::Local, transport.clone());
        (peer, transport)
    }

    #[test]
    fn bounds_direct_json_replies_and_rejects_late_writes_after_overflow() {
        let admission = WebSocketAdmissionController::new(1).unwrap();
        let delivery = PrimarySocketDelivery::new(16);
        let (peer, wire) = attach(&delivery, &admission, 1);
        assert_eq!(
            peer.send(Bytes::from_static(b"0123456789abcdef")),
            SendResult::Queued
        );
        assert_eq!(
            peer.send(Bytes::from_static(b"overflow")),
            SendResult::Dropped
        );
        assert!(wire.terminated.get());
        assert_eq!(wire.close.get(), None);
        assert_eq!(peer.send(Bytes::from_static(b"late")), SendResult::Dropped);
        assert_eq!(wire.deliveries.borrow().len(), 2);
        assert!(admission.try_reserve(Uuid::from_u128(2)).is_ok());
    }

    #[test]
    fn broadcasts_share_the_direct_budget_without_dropping_healthy_subscribers() {
        let admission = WebSocketAdmissionController::new(3).unwrap();
        let delivery = PrimarySocketDelivery::new(16);
        let (slow, slow_wire) = attach(&delivery, &admission, 1);
        let (fast, fast_wire) = attach(&delivery, &admission, 2);
        let (other, other_wire) = attach(&delivery, &admission, 3);
        slow.subscribe("chat");
        fast.subscribe("chat");
        assert!(fast.subscribe("chat"));
        other.subscribe("other");
        slow.send(Bytes::from_static(b"already buffered"));
        let broadcast = Bytes::from_static(b"broadcast");
        assert_eq!(delivery.publish("chat", &broadcast), -1);
        assert!(slow_wire.terminated.get());
        assert!(!fast_wire.terminated.get());
        assert!(other_wire.deliveries.borrow().is_empty());

        fast_wire.buffered.set(0);
        fast_wire.immediate.set(true);
        let large = Bytes::from(vec![b'a'; 128]);
        assert_eq!(delivery.publish("chat", &large), 128);
        assert_eq!(slow_wire.deliveries.borrow().len(), 2);
        assert!(fast.is_open());
        assert_eq!(delivery.publish("missing", &large), 0);
    }

    #[test]
    fn shutdown_fences_current_peers_and_upgrades_admitted_before_shutdown() {
        let admission = WebSocketAdmissionController::new(2).unwrap();
        let delivery = PrimarySocketDelivery::new(16);
        let (first, first_wire) = attach(&delivery, &admission, 1);
        delivery.close();
        let (second, second_wire) = attach(&delivery, &admission, 2);
        for (peer, wire) in [(first, first_wire), (second, second_wire)] {
            assert!(!peer.is_open());
            assert_eq!(peer.send(Bytes::from_static(b"late")), SendResult::Dropped);
            assert_eq!(wire.close.get(), Some(SERVER_SHUTTING_DOWN));
        }
    }

    #[test]
    fn retires_every_selected_peer_before_beginning_any_close() {
        let admission = WebSocketAdmissionController::new(2).unwrap();
        let delivery = PrimarySocketDelivery::new(16);
        let (first, first_wire) = attach(&delivery, &admission, 1);
        let (second, second_wire) = attach(&delivery, &admission, 2);
        let second_during_close = Rc::clone(&second);
        let available_slots = Rc::clone(&admission);
        *first_wire.on_close.borrow_mut() = Some(Box::new(move || {
            assert_eq!(
                second_during_close.send(Bytes::from_static(b"late")),
                SendResult::Dropped
            );
            assert!(available_slots.try_reserve(Uuid::from_u128(3)).is_ok());
        }));
        let revoked = BrowserClose {
            code: 4001,
            reason: "AUTH_REVOKED",
        };
        assert_eq!(delivery.retire_where(|_| Some(revoked)), 2);
        assert!(!first.is_open());
        assert_eq!(first_wire.close.get(), Some(revoked));
        assert_eq!(second_wire.close.get(), Some(revoked));
    }

    #[test]
    fn keeps_socket_identity_across_callbacks_and_prunes_closed_peers() {
        let admission = WebSocketAdmissionController::new(1).unwrap();
        let delivery = PrimarySocketDelivery::new(16);
        let (peer, wire) = attach(&delivery, &admission, 1);
        peer.subscribe("chat");
        let removed = delivery.remove(Uuid::from_u128(1)).unwrap();
        assert!(Rc::ptr_eq(&peer, &removed));
        assert!(delivery.remove(Uuid::from_u128(1)).is_none());
        assert_eq!(peer.send(Bytes::from_static(b"late")), SendResult::Dropped);
        assert!(wire.deliveries.borrow().is_empty());
    }
}
