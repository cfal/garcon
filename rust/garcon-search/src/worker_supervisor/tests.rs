use std::future::ready;
use std::path::PathBuf;

use tokio::sync::oneshot;

use super::*;

const DEADLINE: Duration = Duration::from_secs(5);

fn complete(_: &u64) -> Response {
    Response::Complete
}

#[tokio::test]
async fn timeout_retires_delivery_before_worker_exit_and_leaves_its_peer_available() {
    let (arrived, arrival) = oneshot::channel();
    let (release, hold) = oneshot::channel();
    let held =
        SearchWorker::<u64, u64>::spawn("held-reader", 1, "SEARCH_TIMEOUT", move |mut rx, _| {
            let command = rx.blocking_recv().unwrap();
            arrived.send(()).unwrap();
            hold.blocking_recv().unwrap();
            assert!(
                command
                    .reply
                    .send
                    .blocking_send((command.identity, Ok(command.request)))
                    .is_err()
            );
        })
        .unwrap();
    let peer = SearchWorker::<u64, u64>::spawn("peer-reader", 2, "SEARCH_TIMEOUT", |mut rx, _| {
        let command = rx.blocking_recv().unwrap();
        command
            .reply
            .send
            .blocking_send((command.identity, Ok(command.request)))
            .unwrap();
    })
    .unwrap();

    let request = held.request([17], None, Duration::from_millis(100), complete);
    let (result, arrived) = tokio::join!(request, arrival);
    arrived.unwrap();
    assert_eq!(result, Err(WorkerError::Timeout("SEARCH_TIMEOUT")));
    assert!(!held.available());
    tokio::select! { biased;
        _ = held.wait_closed() => panic!("writer ownership released before exit"),
        () = ready(()) => {},
    }
    assert_eq!(
        held.request([19], None, DEADLINE, complete).await,
        Err(WorkerError::Unavailable)
    );
    assert_eq!(peer.request([23], None, DEADLINE, complete).await, Ok(23));
    release.send(()).unwrap();
    held.wait_closed().await.unwrap();
    peer.wait_closed().await.unwrap();
}

#[tokio::test]
async fn caller_abort_only_unsubscribes_from_that_reply() {
    let (entered, entry) = oneshot::channel();
    let (release, hold) = oneshot::channel();
    let worker =
        SearchWorker::<u64, u64>::spawn("abort-reader", 9, "SEARCH_TIMEOUT", move |mut rx, _| {
            let first = rx.blocking_recv().unwrap();
            entered.send(()).unwrap();
            hold.blocking_recv().unwrap();
            assert!(
                first
                    .reply
                    .send
                    .blocking_send((first.identity, Ok(first.request)))
                    .is_err()
            );
            let second = rx.blocking_recv().unwrap();
            assert_eq!(first.identity.epoch, second.identity.epoch);
            assert_ne!(first.identity.request_id, second.identity.request_id);
            second
                .reply
                .send
                .blocking_send((second.identity, Ok(second.request)))
                .unwrap();
        })
        .unwrap();
    let abort = CancellationToken::new();
    let cancel = async {
        entry.await.unwrap();
        abort.cancel();
    };
    let (result, ()) = tokio::join!(
        worker.request([1], Some(&abort), DEADLINE, complete),
        cancel
    );
    assert_eq!(result, Err(WorkerError::Aborted));
    assert!(worker.available());
    release.send(()).unwrap();
    assert_eq!(worker.request([2], None, DEADLINE, complete).await, Ok(2));
    worker.wait_closed().await.unwrap();
}

#[tokio::test]
async fn an_old_epoch_reply_cannot_resolve_a_current_request() {
    let worker = SearchWorker::<u64, u64>::spawn("bad-reader", 7, "SEARCH_TIMEOUT", |mut rx, _| {
        let command = rx.blocking_recv().unwrap();
        let wrong = WorkerIdentity {
            epoch: command.identity.epoch - 1,
            request_id: command.identity.request_id,
        };
        command
            .reply
            .send
            .blocking_send((wrong, Ok(command.request)))
            .unwrap();
        let _ = command
            .reply
            .send
            .blocking_send((command.identity, Ok(command.request + 1)));
        assert!(rx.blocking_recv().is_none());
    })
    .unwrap();
    assert_eq!(worker.request([11], None, DEADLINE, complete).await, Ok(12));
    assert!(worker.available());
    worker.retire();
    worker.wait_closed().await.unwrap();
}

enum Held {
    Open,
    Hold(oneshot::Sender<()>, oneshot::Receiver<()>),
    Close,
}

fn holding_worker(epoch: u64) -> std::io::Result<SearchWorker<Held, u64>> {
    SearchWorker::spawn(
        "held-writer",
        epoch,
        "WORKER_TIMEOUT",
        move |mut rx, retired| {
            while let Some(command) = rx.blocking_recv() {
                let result = match command.request {
                    Held::Open => epoch,
                    Held::Hold(arrived, hold) => {
                        arrived.send(()).unwrap();
                        hold.blocking_recv().unwrap();
                        assert!(retired.is_cancelled());
                        break;
                    }
                    Held::Close => {
                        let _ = command.reply.send.blocking_send((command.identity, Ok(0)));
                        break;
                    }
                };
                let _ = command
                    .reply
                    .send
                    .blocking_send((command.identity, Ok(result)));
            }
        },
    )
}

#[tokio::test]
async fn a_retired_slot_does_not_admit_its_replacement_while_the_old_owner_is_live() {
    let slot = WorkerSlot::new(
        holding_worker,
        |_| Held::Open,
        || Held::Close,
        |epoch| *epoch != 0,
        |epoch| *epoch == 0,
    );
    assert_eq!(slot.start(PathBuf::new(), None, DEADLINE).await.unwrap(), 1);
    let old = slot.worker().unwrap();
    let (entered, entry) = oneshot::channel();
    let (release, hold) = oneshot::channel();
    let revoke = async {
        entry.await.unwrap();
        slot.retire();
    };
    let (result, ()) = tokio::join!(
        old.request([Held::Hold(entered, hold)], None, DEADLINE, complete),
        revoke
    );
    assert_eq!(result, Err(WorkerError::Unavailable));
    assert!(slot.worker().is_none());
    let mut restart = std::pin::pin!(slot.start(PathBuf::new(), None, DEADLINE));
    tokio::select! { biased;
        _ = &mut restart => panic!("replacement admitted before writer joined"),
        () = ready(()) => {},
    }
    release.send(()).unwrap();
    assert_eq!(restart.await.unwrap(), 2);
    assert!(!old.available());
    assert_eq!(slot.worker().unwrap().epoch(), 2);
    slot.stop(DEADLINE).await.unwrap();
}

fn local_worker() -> (SearchWorker<u64, u64>, mpsc::Receiver<Command<u64, u64>>) {
    let (sender, receiver) = mpsc::channel(CHANNEL_CAPACITY);
    let worker = SearchWorker(Rc::new(Shared {
        epoch: 1,
        timeout_code: "SEARCH_TIMEOUT",
        next_request: Cell::new(0),
        pending: RefCell::new(HashSet::new()),
        sender: RefCell::new(Some(sender)),
        retired: CancellationToken::new(),
        exited: CancellationToken::new(),
        thread: RefCell::new(None),
    }));
    (worker, receiver)
}

#[tokio::test(start_paused = true)]
async fn progress_rearms_the_deadline_until_the_final_reply() {
    let (worker, mut receiver) = local_worker();
    let started = Instant::now();
    let deadline = Duration::from_millis(100);
    let response = worker.request([1], None, deadline, |&event| {
        if event == 1 {
            Response::Progress
        } else {
            Response::Complete
        }
    });
    let actor = async {
        let command = receiver.recv().await.unwrap();
        sleep(Duration::from_millis(70)).await;
        command
            .reply
            .send
            .send((command.identity, Ok(1)))
            .await
            .unwrap();
        sleep(Duration::from_millis(70)).await;
        let _ = command.reply.send.send((command.identity, Ok(2))).await;
    };
    let (result, ()) = tokio::join!(response, actor);
    assert_eq!(result, Ok(2));
    assert!(started.elapsed() > deadline);
    assert!(worker.available());
}

#[tokio::test]
async fn mismatched_phase_retires_the_worker_after_its_envelope_matches() {
    let (worker, mut receiver) = local_worker();
    let request = worker.request([1], None, DEADLINE, |_| Response::Mismatch);
    let actor = async {
        let command = receiver.recv().await.unwrap();
        command
            .reply
            .send
            .send((command.identity, Ok(7)))
            .await
            .unwrap();
    };
    let (result, ()) = tokio::join!(request, actor);
    assert_eq!(result, Err(WorkerError::IdentityMismatch));
    assert!(!worker.available());
}

#[tokio::test]
async fn outstanding_sessions_are_bounded_and_one_session_cannot_overlap_its_phases() {
    let (worker, _receiver) = local_worker();
    let session = worker.begin_session().unwrap();
    let mut first = std::pin::pin!(session.request([0], None, DEADLINE, complete));
    tokio::select! { biased;
        _ = &mut first => panic!("the first request must remain pending"),
        () = ready(()) => {},
    }
    assert_eq!(
        session.request([1], None, DEADLINE, complete).await,
        Err(WorkerError::Active)
    );

    let mut pending = Vec::new();
    for value in 1..CHANNEL_CAPACITY as u64 {
        let mut next = Box::pin(worker.request([value], None, DEADLINE, complete));
        tokio::select! { biased;
            _ = &mut next => panic!("the queue made progress before its receiver was polled"),
            () = ready(()) => {},
        }
        pending.push(next);
    }
    assert_eq!(
        worker.request([99], None, DEADLINE, complete).await,
        Err(WorkerError::Busy)
    );
    assert!(worker.available());
}

fn held_close(epoch: u64) -> std::io::Result<SearchWorker<Held, u64>> {
    SearchWorker::spawn(
        "held-close",
        epoch,
        "WORKER_TIMEOUT",
        move |mut rx, retired| {
            let open = rx.blocking_recv().unwrap();
            assert!(matches!(open.request, Held::Open));
            open.reply
                .send
                .blocking_send((open.identity, Ok(epoch)))
                .unwrap();
            let close = rx.blocking_recv().unwrap();
            assert!(matches!(close.request, Held::Close));
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(retired.cancelled());
        },
    )
}

#[tokio::test]
async fn cooperative_stop_timeout_retires_and_joins_the_worker() {
    let slot = WorkerSlot::new(
        held_close,
        |_| Held::Open,
        || Held::Close,
        |epoch| *epoch != 0,
        |epoch| *epoch == 0,
    );
    slot.start(PathBuf::new(), None, DEADLINE).await.unwrap();
    let worker = slot.worker().unwrap();
    tokio::time::timeout(DEADLINE, slot.stop(Duration::from_millis(100)))
        .await
        .unwrap()
        .unwrap();
    assert!(slot.current_worker().is_none());
    assert!(worker.0.retired.is_cancelled());
    assert!(worker.0.thread.borrow().is_none());
}
