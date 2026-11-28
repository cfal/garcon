use std::{
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    thread::ThreadId,
    time::Duration,
};

use super::*;
use crate::domain_error::as_domain_error;

const LIMIT: Duration = Duration::from_secs(5);
type Worker = TaskWorker<Request, String, (ThreadId, Vec<String>)>;

#[derive(Debug, Clone, Copy)]
enum Request {
    Hold,
    Echo,
    Fail,
    Panic,
}

fn worker() -> Worker {
    TaskWorker::new(
        "garcon-task-worker-test",
        "Synthetic task",
        |request, items, _| match request {
            Request::Hold => unreachable!(),
            Request::Echo => Ok((thread::current().id(), items)),
            Request::Fail => Err(TaskFailure {
                message: "synthetic task failure".into(),
                code: Some("SYNTHETIC".into()),
            }),
            Request::Panic => panic!("synthetic worker failure"),
        },
    )
}

struct HeldWorker {
    worker: Worker,
    started: oneshot::Receiver<(ThreadId, CancellationToken)>,
    release: mpsc::Sender<()>,
    echoes: Arc<AtomicUsize>,
}

fn held_worker() -> HeldWorker {
    let (notify, started) = oneshot::channel();
    let (release, resume) = mpsc::channel();
    let notify = Mutex::new(Some(notify));
    let resume = Mutex::new(resume);
    let echoes = Arc::new(AtomicUsize::new(0));
    let worker = TaskWorker::new("garcon-task-worker-test", "Synthetic task", {
        let echoes = echoes.clone();
        move |request, items, token| {
            if matches!(request, Request::Hold) {
                notify
                    .lock()
                    .unwrap()
                    .take()
                    .unwrap()
                    .send((thread::current().id(), token.clone()))
                    .unwrap();
                // Deliberately ignores cancellation to exercise the retirement fence.
                resume.lock().unwrap().recv_timeout(LIMIT).unwrap();
                return Ok((thread::current().id(), vec!["retired result".into()]));
            }
            echoes.fetch_add(1, Ordering::SeqCst);
            Ok((thread::current().id(), items))
        }
    });
    HeldWorker {
        worker,
        started,
        release,
        echoes,
    }
}

#[tokio::test]
async fn starts_lazily_and_moves_typed_items_off_thread_without_copying() {
    let worker = worker();
    assert!(worker.thread.borrow().is_none());
    let core = thread::current().id();
    let input = vec!["synthetic payload".repeat(32_768)];
    let allocated = input[0].as_ptr();
    let (worker_id, output) = worker.run(Request::Echo, input, None).await.unwrap();
    assert_ne!(worker_id, core);
    assert_eq!(output[0].as_ptr(), allocated);
    assert_eq!(
        worker.run(Request::Echo, Vec::new(), None).await.unwrap().0,
        worker_id
    );
}

#[tokio::test]
async fn a_task_error_preserves_its_code_and_does_not_restart_the_thread() {
    let worker = worker();
    let (id, _) = worker.run(Request::Echo, vec![], None).await.unwrap();
    let error = worker.run(Request::Fail, vec![], None).await.unwrap_err();
    assert_eq!(error.to_string(), "synthetic task failure");
    assert_eq!(error_metadata(error.as_ref()).code, Some("SYNTHETIC"));
    assert_eq!(worker.run(Request::Echo, vec![], None).await.unwrap().0, id);
}

#[tokio::test]
async fn a_worker_panic_only_fails_its_active_job_and_queued_work_continues() {
    let worker = worker();
    let (id, _) = worker.run(Request::Echo, vec![], None).await.unwrap();
    let (failure, echo) = tokio::join!(
        worker.run(Request::Panic, vec![], None),
        worker.run(Request::Echo, vec!["next".into()], None),
    );
    assert_eq!(
        failure.unwrap_err().to_string(),
        "Synthetic task worker failed: synthetic worker failure"
    );
    let (successor, echo) = echo.unwrap();
    assert_ne!(id, successor);
    assert_eq!(echo, ["next"]);
}

#[tokio::test]
async fn cancellation_rejects_immediately_but_does_not_run_next_to_a_retired_handler() {
    let HeldWorker {
        worker,
        started,
        release,
        echoes,
    } = held_worker();
    let signal = CancellationToken::new();
    let mut active = Box::pin(worker.run_with_abort_reason(
        Request::Hold,
        vec![],
        Some(&signal),
        || io::Error::other("synthetic abort reason").into(),
    ));
    assert!(futures::poll!(&mut active).is_pending());
    let (original, token) = tokio::time::timeout(LIMIT, started).await.unwrap().unwrap();

    let mut next = Box::pin(worker.run(Request::Echo, vec!["fresh result".into()], None));
    assert!(futures::poll!(&mut next).is_pending());
    signal.cancel();
    let error = tokio::time::timeout(LIMIT, active)
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<io::Error>().unwrap().to_string(),
        "synthetic abort reason"
    );
    assert!(token.is_cancelled());
    assert!(worker.thread.borrow().is_none());
    assert_eq!(worker.running.available_permits(), 0);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut next)
            .await
            .is_err()
    );
    assert_eq!(echoes.load(Ordering::SeqCst), 0);

    release.send(()).unwrap();
    let (successor, value) = tokio::time::timeout(LIMIT, next).await.unwrap().unwrap();
    assert_ne!(original, successor);
    assert_eq!(value, ["fresh result"]);
    assert_eq!(echoes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn dropping_a_job_signals_its_handler_and_retires_the_thread() {
    let HeldWorker {
        worker,
        started,
        release,
        ..
    } = held_worker();
    let mut active = Box::pin(worker.run(Request::Hold, vec![], None));
    assert!(futures::poll!(&mut active).is_pending());
    let (original, token) = tokio::time::timeout(LIMIT, started).await.unwrap().unwrap();
    drop(active);
    assert!(token.is_cancelled());

    let mut next = Box::pin(worker.run(Request::Echo, vec![], None));
    assert!(futures::poll!(&mut next).is_pending());
    release.send(()).unwrap();
    let (successor, _) = tokio::time::timeout(LIMIT, next).await.unwrap().unwrap();
    assert_ne!(original, successor);
}

#[tokio::test]
async fn an_already_aborted_job_does_not_start_a_thread() {
    let worker = worker();
    let signal = CancellationToken::new();
    signal.cancel();
    let error = worker
        .run(Request::Echo, vec![], Some(&signal))
        .await
        .unwrap_err();
    assert!(error.is::<LockAborted>());
    assert!(worker.thread.borrow().is_none());
}

#[tokio::test]
async fn bounds_the_queue_and_removes_aborted_waiters_before_they_get_a_slot() {
    let HeldWorker {
        worker,
        started,
        release,
        echoes,
    } = held_worker();
    let mut active = Box::pin(worker.run(Request::Hold, vec![], None));
    assert!(futures::poll!(&mut active).is_pending());
    tokio::time::timeout(LIMIT, started).await.unwrap().unwrap();
    let signals = std::array::from_fn::<_, MAX_QUEUED_TASKS, _>(|_| CancellationToken::new());
    let mut queued = Vec::new();
    for (i, signal) in signals.iter().enumerate() {
        let mut request = Box::pin(worker.run(Request::Echo, vec![i.to_string()], Some(signal)));
        assert!(futures::poll!(&mut request).is_pending());
        queued.push(request);
    }

    let busy = worker.run(Request::Echo, vec![], None).await.unwrap_err();
    let busy = as_domain_error(busy.as_ref()).unwrap();
    assert_eq!(
        (busy.code, busy.status, busy.retryable),
        (ErrorCode::TRANSCRIPT_WORK_BUSY, 503, true)
    );
    assert_eq!(
        busy.message,
        "Synthetic task capacity is full. Try again later."
    );
    signals[3].cancel();
    let error = queued.remove(3).await.unwrap_err();
    assert!(error.is::<LockAborted>());
    let mut replacement = Box::pin(worker.run(Request::Echo, vec!["replacement".into()], None));
    assert!(futures::poll!(&mut replacement).is_pending());

    release.send(()).unwrap();
    assert_eq!(
        tokio::time::timeout(LIMIT, active)
            .await
            .unwrap()
            .unwrap()
            .1,
        ["retired result"]
    );
    for (request, i) in queued
        .into_iter()
        .zip((0..MAX_QUEUED_TASKS).filter(|&i| i != 3))
    {
        assert_eq!(
            tokio::time::timeout(LIMIT, request)
                .await
                .unwrap()
                .unwrap()
                .1,
            [i.to_string()]
        );
    }
    assert_eq!(
        tokio::time::timeout(LIMIT, replacement)
            .await
            .unwrap()
            .unwrap()
            .1,
        ["replacement"]
    );
    assert_eq!(echoes.load(Ordering::SeqCst), MAX_QUEUED_TASKS);
}

#[tokio::test]
async fn close_signals_the_active_thread_and_rejects_queued_and_new_jobs() {
    let HeldWorker {
        worker,
        started,
        release,
        echoes,
    } = held_worker();
    let mut active = Box::pin(worker.run(Request::Hold, vec![], None));
    assert!(futures::poll!(&mut active).is_pending());
    let (_, token) = tokio::time::timeout(LIMIT, started).await.unwrap().unwrap();
    let mut queued = Box::pin(worker.run(Request::Echo, vec![], None));
    assert!(futures::poll!(&mut queued).is_pending());
    worker.close();
    worker.close();
    assert!(token.is_cancelled());
    let signal = CancellationToken::new();
    signal.cancel();
    for error in [
        tokio::time::timeout(LIMIT, active)
            .await
            .unwrap()
            .unwrap_err(),
        tokio::time::timeout(LIMIT, queued)
            .await
            .unwrap()
            .unwrap_err(),
        worker
            .run(Request::Echo, vec![], Some(&signal))
            .await
            .unwrap_err(),
    ] {
        assert_eq!(error.to_string(), "Synthetic task is closed");
    }
    assert_eq!(echoes.load(Ordering::SeqCst), 0);
    release.send(()).unwrap();
}
