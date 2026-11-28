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
