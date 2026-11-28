use std::{cell::RefCell, io};

use tokio::task::LocalSet;

use crate::{
    indexer::IndexerWorker,
    schema::{close_search_database, open_search_database},
    transcript_search_service::tests::{Logs, directory, eventually, service},
    worker_protocol::WorkerFailure,
    worker_supervisor::{SearchWorker, WorkerSlot},
};

use super::*;

fn flaky_counts(epoch: u64) -> io::Result<IndexerWorker> {
    SearchWorker::spawn("test-counts", epoch, "WORKER_TIMEOUT", move |mut rx, _| {
        let mut db = None;
        let mut bad_snapshot = true;
        while let Some(command) = rx.blocking_recv() {
            let close = matches!(command.request, IndexerRequest::Close);
            let result = match command.request {
                IndexerRequest::Open(path) => {
                    let opened = open_search_database(&path).unwrap();
                    db = Some(opened.db);
                    Ok(IndexerEvent::Opened {
                        recreated: opened.recreated,
                    })
                }
                IndexerRequest::StatusSnapshot if std::mem::replace(&mut bad_snapshot, false) => {
                    Err(WorkerFailure::new("INDEXER_INTERNAL", true).into())
                }
                IndexerRequest::StatusSnapshot => Ok(IndexerEvent::Status {
                    counts: empty_counts(),
                }),
                IndexerRequest::Close => {
                    close_search_database(db.take().unwrap()).unwrap();
                    Ok(IndexerEvent::Closed)
                }
                _ => panic!("unexpected request to status fixture"),
            };
            let _ = command.reply.send.blocking_send((command.identity, result));
            if close {
                break;
            }
        }
    })
}

#[tokio::test]
async fn a_failed_count_readback_never_publishes_ready_before_retry() {
    LocalSet::new()
        .run_until(async {
            let dir = directory();
            let mut service = service(dir.path(), Rc::new(Logs::default()));
            Rc::get_mut(&mut service).unwrap().indexer = WorkerSlot::new(
                flaky_counts,
                IndexerRequest::Open,
                || IndexerRequest::Close,
                |event| matches!(event, IndexerEvent::Opened { .. }),
                |event| matches!(event, IndexerEvent::Closed),
            );
            let records = Rc::new(RefCell::new(Vec::new()));
            let listener = records.clone();
            let _listen = service.on_status_changed(Rc::new(move |status| {
                listener.borrow_mut().push(status.phase)
            }));
            let signal = CancellationToken::new();
            service.enable(&signal).await.unwrap();
            service.begin_resync(0).unwrap().complete().unwrap();
            eventually(|| service.status.borrow().retry_armed).await;
            assert!(!records.borrow().contains(&TranscriptSearchPhase::Ready));
            assert!(service.status.borrow().counts_dirty);
            eventually(|| service.status().phase == TranscriptSearchPhase::Ready).await;
            assert!(!service.status.borrow().counts_dirty);
            service.close().await;
        })
        .await;
}
