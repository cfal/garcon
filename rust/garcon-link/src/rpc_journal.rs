//! Ports `server/remote/transport/rpc-journal.ts`.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::time::Duration;

use indexmap::IndexMap;
use tokio::task::{JoinHandle, spawn_local};
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::limits::{BULK_JOURNAL_BYTES, RPC_JOURNAL_BYTES};
use crate::rpc_admission::RpcAdmission;
use crate::rpc_lane::RpcLane;
use crate::rpc_protocol::{OutstandingCall, OutstandingCallState, OutstandingCallStatus};

const RECEIPT_SESSIONS: usize = 16;
const DELIVERY_RETRY_MS: u64 = 10;

pub trait RpcJournalOwner {
    fn lane(&self) -> RpcLane;
    fn session(&self) -> &str;
    fn offer(&self, payload: &str) -> bool;
}

#[derive(Default)]
struct Entry {
    owner: Option<Rc<dyn RpcJournalOwner>>,
    reply: Option<Rc<str>>,
    undeliverable: Option<Rc<str>>,
    delivered: bool,
    cancelled: bool,
}

pub struct JournaledCall {
    pub id: String,
    pub signal: CancellationToken,
    lane: RpcLane,
    entry: RefCell<Entry>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RpcReplyJournalOptions {
    pub retained_bytes: Option<usize>,
    pub bulk_retained_bytes: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JournalError {
    #[error("RPC receipt lane mismatch")]
    ReceiptLaneMismatch,
    #[error("RPC reconciliation ownership mismatch")]
    ReconciliationOwnershipMismatch,
}

#[derive(Default)]
struct State {
    entries: IndexMap<String, Rc<JournaledCall>>,
    received: IndexMap<String, (RpcLane, u64)>,
    retained_bytes: usize,
    bulk_retained_bytes: usize,
    running: usize,
    retry: Option<JoinHandle<()>>,
}

pub struct RpcReplyJournal {
    pub admission: RpcAdmission,
    retained_limit: usize,
    bulk_retained_limit: usize,
    state: RefCell<State>,
}

impl RpcReplyJournal {
    pub fn new(options: RpcReplyJournalOptions) -> Rc<Self> {
        let retained_limit = options.retained_bytes.unwrap_or(RPC_JOURNAL_BYTES);
        let bulk_retained_limit = options
            .bulk_retained_bytes
            .unwrap_or_else(|| BULK_JOURNAL_BYTES.min(retained_limit - retained_limit.div_ceil(4)));
        Rc::new(Self {
            admission: RpcAdmission::default(),
            retained_limit,
            bulk_retained_limit,
            state: RefCell::default(),
        })
    }

    pub fn running(&self) -> usize {
        self.state.borrow().running
    }

    pub fn size(&self) -> usize {
        self.state.borrow().entries.len()
    }

    pub fn has(&self, id: &str) -> bool {
        self.state.borrow().entries.contains_key(id)
    }

    pub fn received(&self, owner: &dyn RpcJournalOwner, seq: u64) -> Result<(), JournalError> {
        let (session, lane) = (owner.session(), owner.lane());
        let mut state = self.state.borrow_mut();
        if state
            .received
            .get(session)
            .is_some_and(|(prior, _)| *prior != lane)
        {
            return Err(JournalError::ReceiptLaneMismatch);
        }
        state.received.shift_remove(session);
        state.received.insert(session.to_owned(), (lane, seq));
        let mut sessions = state
            .received
            .iter()
            .enumerate()
            .filter(|(_, (_, (stored, _)))| *stored == lane);
        if let Some((first, _)) = sessions.next()
            && sessions.count() >= RECEIPT_SESSIONS
        {
            state.received.shift_remove_index(first);
        }
        Ok(())
    }

    pub fn begin(&self, owner: Rc<dyn RpcJournalOwner>, id: String) -> Rc<JournaledCall> {
        let call = Rc::new(JournaledCall {
            id,
            signal: CancellationToken::new(),
            lane: owner.lane(),
            entry: RefCell::new(Entry {
                owner: Some(owner),
                ..Entry::default()
            }),
        });
        let mut state = self.state.borrow_mut();
        state.entries.insert(call.id.clone(), Rc::clone(&call));
        state.running += 1;
        call
    }

    pub fn complete(
        self: &Rc<Self>,
        call: &Rc<JournaledCall>,
        reply: String,
        undeliverable: String,
    ) {
        {
            let mut state = self.state.borrow_mut();
            state.running -= 1;
            if !state
                .entries
                .get(&call.id)
                .is_some_and(|current| Rc::ptr_eq(current, call))
            {
                return;
            }
            let mut entry = call.entry.borrow_mut();
            if entry.cancelled {
                state.entries.shift_remove(&call.id);
                return;
            }
            state.retained_bytes += reply.len();
            if call.lane == RpcLane::Bulk {
                state.bulk_retained_bytes += reply.len();
            }
            entry.reply = Some(Rc::from(reply));
            entry.undeliverable = Some(Rc::from(undeliverable));
            drop(entry);
            self.evict(&mut state, call.lane);
        }
        self.deliver();
    }

    pub fn cancel(&self, owner: &Rc<dyn RpcJournalOwner>, id: &str) {
        let mut state = self.state.borrow_mut();
        let call = state
            .entries
            .get(id)
            .filter(|call| owned_by(&call.entry.borrow(), owner))
            .cloned();
        if let Some(call) = call {
            discard(&mut state, &call);
        }
    }

    pub fn acknowledge(&self, owner: &Rc<dyn RpcJournalOwner>, ids: &[String]) {
        let mut state = self.state.borrow_mut();
        for id in ids {
            if let Some(call) = state.entries.get(id).cloned() {
                let entry = call.entry.borrow();
                if owned_by(&entry, owner) && entry.reply.is_some() {
                    forget(&mut state, &call, &entry);
                }
            }
        }
    }

    pub fn owner_lost(&self, owner: &Rc<dyn RpcJournalOwner>) {
        for call in self.state.borrow().entries.values() {
            let mut entry = call.entry.borrow_mut();
            if owned_by(&entry, owner) {
                entry.owner = None;
                entry.delivered = false;
            }
        }
    }

    pub fn reconcile(
        &self,
        owner: &Rc<dyn RpcJournalOwner>,
        calls: &[OutstandingCall],
    ) -> Result<Vec<OutstandingCallState>, JournalError> {
        let mut state = self.state.borrow_mut();
        let lane = owner.lane();
        let mut ids = HashSet::with_capacity(calls.len());
        for call in calls {
            if !ids.insert(&call.id)
                || state.entries.get(&call.id).is_some_and(|current| {
                    let entry = current.entry.borrow();
                    current.lane != lane || entry.owner.is_some() && !owned_by(&entry, owner)
                })
                || state
                    .received
                    .get(&call.session)
                    .is_some_and(|(receipt_lane, _)| *receipt_lane != lane)
            {
                return Err(JournalError::ReconciliationOwnershipMismatch);
            }
        }
        let states = calls
            .iter()
            .map(|call| {
                let current = state
                    .entries
                    .get(&call.id)
                    .filter(|current| !current.entry.borrow().cancelled);
                let status = if let Some(current) = current {
                    let mut entry = current.entry.borrow_mut();
                    entry.owner = Some(Rc::clone(owner));
                    entry.delivered = false;
                    OutstandingCallStatus::Pending
                } else if state
                    .received
                    .get(&call.session)
                    .is_some_and(|(_, seq)| call.seq > *seq)
                {
                    OutstandingCallStatus::NotReceived
                } else {
                    OutstandingCallStatus::Unknown
                };
                OutstandingCallState {
                    id: call.id.clone(),
                    state: status,
                }
            })
            .collect();
        let lost: Vec<_> = state
            .entries
            .values()
            .filter(|call| call.lane == lane && call.entry.borrow().owner.is_none())
            .cloned()
            .collect();
        for call in lost {
            discard(&mut state, &call);
        }
        Ok(states)
    }

    pub fn deliver(self: &Rc<Self>) {
        let mut blocked = HashSet::new();
        let calls: Vec<_> = self.state.borrow().entries.values().cloned().collect();
        for call in calls {
            if blocked.contains(&call.lane) {
                continue;
            }
            let next = {
                let entry = call.entry.borrow();
                if entry.delivered {
                    continue;
                }
                entry.owner.clone().zip(entry.reply.clone())
            };
            let Some((owner, reply)) = next else {
                continue;
            };
            if owner.offer(&reply) {
                call.entry.borrow_mut().delivered = true;
            } else {
                self.schedule_retry();
                blocked.insert(call.lane);
            }
        }
    }

    fn schedule_retry(self: &Rc<Self>) {
        let mut state = self.state.borrow_mut();
        if state.retry.is_none() {
            let journal = Rc::clone(self);
            let deadline = Instant::now() + Duration::from_millis(DELIVERY_RETRY_MS);
            state.retry = Some(spawn_local(async move {
                sleep_until(deadline).await;
                journal.state.borrow_mut().retry = None;
                journal.deliver();
            }));
        }
    }

    pub fn dispose(&self) {
        let mut state = self.state.borrow_mut();
        for call in state.entries.values() {
            call.signal.cancel();
        }
        state.entries.clear();
        state.received.clear();
        state.retained_bytes = 0;
        state.bulk_retained_bytes = 0;
        if let Some(retry) = state.retry.take() {
            retry.abort();
        }
    }

    fn evict(&self, state: &mut State, lane: RpcLane) {
        evict_replies(state, Some(RpcLane::Bulk), |state| {
            state.bulk_retained_bytes > self.bulk_retained_limit
        });
        evict_replies(
            state,
            (lane == RpcLane::Bulk).then_some(RpcLane::Bulk),
            |state| state.retained_bytes > self.retained_limit,
        );
    }
}

fn owned_by(entry: &Entry, owner: &Rc<dyn RpcJournalOwner>) -> bool {
    entry
        .owner
        .as_ref()
        .is_some_and(|current| Rc::ptr_eq(current, owner))
}

fn discard(state: &mut State, call: &JournaledCall) {
    let mut entry = call.entry.borrow_mut();
    entry.cancelled = true;
    call.signal.cancel();
    if entry.reply.is_some() {
        forget(state, call, &entry);
    }
}

fn forget(state: &mut State, call: &JournaledCall, entry: &Entry) {
    state.entries.shift_remove(&call.id);
    if let Some(reply) = &entry.reply {
        replace_bytes(state, call.lane, reply.len(), 0);
    }
}

fn replace_bytes(state: &mut State, lane: RpcLane, old: usize, new: usize) {
    state.retained_bytes = state.retained_bytes - old + new;
    if lane == RpcLane::Bulk {
        state.bulk_retained_bytes = state.bulk_retained_bytes - old + new;
    }
}

fn evict_replies(state: &mut State, lane: Option<RpcLane>, over_limit: impl Fn(&State) -> bool) {
    for delivered in [true, false] {
        for call in state.entries.values().cloned().collect::<Vec<_>>() {
            if !over_limit(state) {
                return;
            }
            let mut entry = call.entry.borrow_mut();
            if lane.is_some_and(|lane| lane != call.lane)
                || entry.delivered != delivered
                || entry.reply.is_none()
                || entry.reply == entry.undeliverable
            {
                continue;
            }
            if delivered || entry.owner.is_none() || entry.undeliverable.is_none() {
                forget(state, &call, &entry);
            } else if let Some(placeholder) = entry.undeliverable.clone() {
                let previous = entry.reply.replace(placeholder);
                replace_bytes(
                    state,
                    call.lane,
                    previous.as_deref().map_or(0, str::len),
                    entry.reply.as_deref().map_or(0, str::len),
                );
            }
        }
    }
    for call in state.entries.values().cloned().collect::<Vec<_>>() {
        if !over_limit(state) {
            return;
        }
        let entry = call.entry.borrow();
        if entry.reply.is_some() && lane.is_none_or(|lane| lane == call.lane) {
            forget(state, &call, &entry);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;
    use OutstandingCallStatus::{NotReceived, Pending, Unknown};

    const UNKNOWN: &str = "unknown-outcome";

    struct Owner {
        session: String,
        lane: RpcLane,
        accepting: Cell<bool>,
        offered: RefCell<Vec<String>>,
    }

    impl RpcJournalOwner for Owner {
        fn lane(&self) -> RpcLane {
            self.lane
        }
        fn session(&self) -> &str {
            &self.session
        }
        fn offer(&self, reply: &str) -> bool {
            if self.accepting.get() {
                self.offered.borrow_mut().push(reply.to_owned());
                true
            } else {
                false
            }
        }
    }

    fn owner(session: &str, lane: RpcLane) -> Rc<Owner> {
        Rc::new(Owner {
            session: session.to_owned(),
            lane,
            accepting: Cell::new(true),
            offered: RefCell::default(),
        })
    }

    fn peer(owner: &Rc<Owner>) -> Rc<dyn RpcJournalOwner> {
        owner.clone()
    }

    fn outstanding(id: &str, session: &str, seq: u64) -> OutstandingCall {
        OutstandingCall {
            id: id.to_owned(),
            session: session.to_owned(),
            seq,
        }
    }

    fn finish(journal: &Rc<RpcReplyJournal>, call: &Rc<JournaledCall>, reply: &str) {
        journal.complete(call, reply.to_owned(), UNKNOWN.to_owned());
    }

    #[test]
    fn delivers_a_reply_to_the_owning_session_and_releases_it_once_acknowledged() {
        let journal = RpcReplyJournal::new(RpcReplyJournalOptions::default());
        let first = owner("session-1", RpcLane::Primary);
        let call = journal.begin(peer(&first), "call-1".to_owned());
        assert_eq!(journal.running(), 1);
        finish(&journal, &call, "reply-1");
        assert_eq!(*first.offered.borrow(), ["reply-1"]);
        assert_eq!(journal.running(), 0);
        journal.acknowledge(&peer(&first), std::slice::from_ref(&call.id));
        assert!(!journal.has(&call.id));
    }

    #[test]
    fn reconciles_running_completed_never_received_and_forgotten_calls_of_a_lost_session() {
        let journal = RpcReplyJournal::new(RpcReplyJournalOptions::default());
        let first = owner("session-1", RpcLane::Primary);
        let second = owner("session-2", RpcLane::Primary);
        for seq in 1..=3 {
            journal.received(first.as_ref(), seq).unwrap();
        }
        let running = journal.begin(peer(&first), "running".to_owned());
        let completed = journal.begin(peer(&first), "completed".to_owned());
        let abandoned = journal.begin(peer(&first), "abandoned".to_owned());
        finish(&journal, &completed, "completed-reply");
        journal.owner_lost(&peer(&first));
        let calls = [
            outstanding("running", "session-1", 1),
            outstanding("completed", "session-1", 2),
            outstanding("lost-request", "session-1", 4),
            outstanding("forgotten", "session-1", 3),
            outstanding("other-session", "session-0", 9),
        ];
        let states = journal.reconcile(&peer(&second), &calls).unwrap();
        assert_eq!(
            states.iter().map(|state| state.state).collect::<Vec<_>>(),
            [Pending, Pending, NotReceived, Unknown, Unknown],
        );
        assert!(abandoned.signal.is_cancelled());
        assert!(!running.signal.is_cancelled());
        journal.deliver();
        assert_eq!(*second.offered.borrow(), ["completed-reply"]);
        finish(&journal, &running, "running-reply");
        finish(&journal, &abandoned, "abandoned-reply");
        assert_eq!(
            *second.offered.borrow(),
            ["completed-reply", "running-reply"]
        );
        assert_eq!(*first.offered.borrow(), ["completed-reply"]);
        assert!(!journal.has("abandoned"));
    }

    #[tokio::test(start_paused = true)]
    async fn offers_a_refused_reply_again_and_redelivers_one_sent_to_a_lost_session() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let journal = RpcReplyJournal::new(RpcReplyJournalOptions::default());
                let first = owner("session-1", RpcLane::Primary);
                let second = owner("session-2", RpcLane::Primary);
                first.accepting.set(false);
                let call = journal.begin(peer(&first), "call-1".to_owned());
                finish(&journal, &call, "reply-1");
                assert!(first.offered.borrow().is_empty());
                first.accepting.set(true);
                tokio::time::sleep(Duration::from_millis(30)).await;
                assert_eq!(*first.offered.borrow(), ["reply-1"]);
                journal.owner_lost(&peer(&first));
                let states = journal
                    .reconcile(&peer(&second), &[outstanding("call-1", "session-1", 1)])
                    .unwrap();
                assert_eq!(states[0].state, Pending);
                journal.deliver();
                assert_eq!(*second.offered.borrow(), ["reply-1"]);
                journal.dispose();
            })
            .await;
    }

    #[tokio::test]
    async fn drops_delivered_replies_first_then_answers_waiting_calls_with_unknown_under_pressure()
    {
        tokio::task::LocalSet::new()
            .run_until(async {
                let journal = RpcReplyJournal::new(RpcReplyJournalOptions {
                    retained_bytes: Some(25),
                    bulk_retained_bytes: None,
                });
                let first = owner("session-1", RpcLane::Primary);
                finish(
                    &journal,
                    &journal.begin(peer(&first), "delivered".to_owned()),
                    &"x".repeat(10),
                );
                first.accepting.set(false);
                finish(
                    &journal,
                    &journal.begin(peer(&first), "waiting".to_owned()),
                    &"y".repeat(20),
                );
                assert!(!journal.has("delivered"));
                finish(
                    &journal,
                    &journal.begin(peer(&first), "newest".to_owned()),
                    &"z".repeat(10),
                );
                first.accepting.set(true);
                journal.deliver();
                assert_eq!(
                    *first.offered.borrow(),
                    ["x".repeat(10), UNKNOWN.to_owned(), "z".repeat(10)]
                );
                journal.dispose();
            })
            .await;
    }

    #[test]
    fn a_cancelled_call_is_aborted_and_its_reply_dropped() {
        let journal = RpcReplyJournal::new(RpcReplyJournalOptions::default());
        let first = owner("session-1", RpcLane::Primary);
        let call = journal.begin(peer(&first), "call-1".to_owned());
        journal.cancel(&peer(&first), &call.id);
        assert!(call.signal.is_cancelled());
        finish(&journal, &call, "reply-1");
        assert!(first.offered.borrow().is_empty());
        assert!(!journal.has(&call.id));
        assert_eq!(journal.running(), 0);
    }

    #[tokio::test]
    async fn forgets_lost_undelivered_replies_under_pressure() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let journal = RpcReplyJournal::new(RpcReplyJournalOptions {
                    retained_bytes: Some(30),
                    bulk_retained_bytes: None,
                });
                let first = owner("session-1", RpcLane::Primary);
                let second = owner("session-2", RpcLane::Primary);
                first.accepting.set(false);
                journal.received(first.as_ref(), 2).unwrap();
                finish(
                    &journal,
                    &journal.begin(peer(&first), "lost".to_owned()),
                    &"y".repeat(20),
                );
                journal.owner_lost(&peer(&first));
                finish(
                    &journal,
                    &journal.begin(peer(&second), "newest".to_owned()),
                    &"z".repeat(20),
                );
                let states = journal
                    .reconcile(&peer(&second), &[outstanding("lost", "session-1", 1)])
                    .unwrap();
                assert_eq!(states[0].state, Unknown);
                assert_eq!(*second.offered.borrow(), ["z".repeat(20)]);
                journal.dispose();
            })
            .await;
    }

    #[test]
    fn bulk_recovery_neither_cancels_nor_claims_primary_work() {
        let journal = RpcReplyJournal::new(RpcReplyJournalOptions::default());
        let primary = owner("primary", RpcLane::Primary);
        let bulk = owner("bulk", RpcLane::Bulk);
        let replacement = owner("new-bulk", RpcLane::Bulk);
        journal.received(primary.as_ref(), 1).unwrap();
        journal.received(bulk.as_ref(), 1).unwrap();
        let control = journal.begin(peer(&primary), "control".to_owned());
        let transfer = journal.begin(peer(&bulk), "transfer".to_owned());
        journal.owner_lost(&peer(&primary));
        journal.owner_lost(&peer(&bulk));
        let states = journal
            .reconcile(&peer(&replacement), &[outstanding("transfer", "bulk", 1)])
            .unwrap();
        assert_eq!(states[0].state, Pending);
        assert!(!control.signal.is_cancelled());
        for call in [
            outstanding("control", "primary", 1),
            outstanding("absent", "primary", 2),
        ] {
            assert_eq!(
                journal.reconcile(&peer(&replacement), &[call]),
                Err(JournalError::ReconciliationOwnershipMismatch)
            );
        }
        journal.cancel(&peer(&primary), &transfer.id);
        assert!(!transfer.signal.is_cancelled());
        finish(&journal, &transfer, "reply");
        journal.acknowledge(&peer(&primary), std::slice::from_ref(&transfer.id));
        assert!(journal.has(&transfer.id));
        journal.acknowledge(&peer(&replacement), std::slice::from_ref(&transfer.id));
        assert!(!journal.has(&transfer.id));
        journal.dispose();
    }

    #[tokio::test]
    async fn blocked_bulk_delivery_and_retention_cannot_consume_primary_reservations() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let journal = RpcReplyJournal::new(RpcReplyJournalOptions {
                    retained_bytes: Some(100),
                    bulk_retained_bytes: Some(75),
                });
                let bulk = owner("bulk", RpcLane::Bulk);
                let primary = owner("primary", RpcLane::Primary);
                bulk.accepting.set(false);
                finish(
                    &journal,
                    &journal.begin(peer(&bulk), "bulk-1".to_owned()),
                    &"b".repeat(70),
                );
                finish(
                    &journal,
                    &journal.begin(peer(&primary), "primary-1".to_owned()),
                    &"p".repeat(25),
                );
                assert_eq!(*primary.offered.borrow(), ["p".repeat(25)]);
                finish(
                    &journal,
                    &journal.begin(peer(&bulk), "bulk-2".to_owned()),
                    &"c".repeat(70),
                );
                assert!(journal.has("primary-1"));
                journal.dispose();
            })
            .await;
    }

    #[test]
    fn bulk_flaps_do_not_evict_primary_receipt_history() {
        let journal = RpcReplyJournal::new(RpcReplyJournalOptions::default());
        journal
            .received(owner("primary", RpcLane::Primary).as_ref(), 1)
            .unwrap();
        for i in 0..32 {
            journal
                .received(owner(&format!("bulk-{i}"), RpcLane::Bulk).as_ref(), 1)
                .unwrap();
        }
        let new_primary = owner("new-primary", RpcLane::Primary);
        let states = journal
            .reconcile(
                &peer(&new_primary),
                &[outstanding("not-sent", "primary", 2)],
            )
            .unwrap();
        assert_eq!(states[0].state, NotReceived);
        journal.dispose();
    }
}
