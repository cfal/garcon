use tokio::{task::LocalSet, time::timeout};

use super::*;
use crate::transcript_search_service::tests::{Logs, directory, eventually, service};

#[tokio::test]
async fn two_readers_and_four_waiters_bound_admission_and_cancellation_is_lane_local() {
    LocalSet::new()
        .run_until(async {
            let dir = directory();
            let service = service(dir.path(), Rc::new(Logs::default()));
            let live = CancellationToken::new();
            service.enable(&live).await.unwrap();
            let first = service.acquire(None, &live).await.unwrap();
            let second = service.acquire(None, &live).await.unwrap();
            let first_epoch = first.worker.epoch();
            let second_epoch = second.worker.epoch();

            let mut queue = Vec::new();
            let mut admissions = Vec::new();
            let mut executions = Vec::new();
            for depth in 1..=4 {
                let owner = service.clone();
                let admission = CancellationToken::new();
                let execution = CancellationToken::new();
                admissions.push(admission.clone());
                executions.push(execution.clone());
                queue.push(tokio::task::spawn_local(async move {
                    owner.acquire(Some(&admission), &execution).await
                }));
                eventually(|| service.readers.waiters.borrow().len() == depth).await;
            }
            assert!(matches!(
                timeout(
                    std::time::Duration::from_millis(100),
                    service.acquire(None, &live)
                )
                .await,
                Ok(Err(SearchServiceError::Busy))
            ));
            assert_eq!(service.query_stats().rejected_busy, 1);
            assert_eq!(service.query_stats().served, 0);
            assert_eq!(service.query_stats().timed_out, 0);

            admissions[0].cancel();
            executions[1].cancel();
            assert!(matches!(
                queue.remove(0).await.unwrap(),
                Err(SearchServiceError::Aborted)
            ));
            assert!(matches!(
                queue.remove(0).await.unwrap(),
                Err(SearchServiceError::Timeout)
            ));
            assert_eq!(service.readers.waiters.borrow().len(), 2);
            assert_eq!(service.query_stats().timed_out, 1);
            assert!(
                service.readers.slots[0]
                    .worker
                    .worker()
                    .is_some_and(|worker| worker.epoch() == first_epoch)
            );
            assert!(
                service.readers.slots[1]
                    .worker
                    .worker()
                    .is_some_and(|worker| worker.epoch() == second_epoch)
            );

            drop(first);
            let next = queue.remove(0).await.unwrap().unwrap();
            assert_eq!(next.index, 0);
            assert_eq!(service.readers.waiters.borrow().len(), 1);
            drop(next);
            let last = queue.remove(0).await.unwrap().unwrap();
            assert_eq!(last.index, 0);
            assert!(service.readers.waiters.borrow().is_empty());
            drop(last);
            drop(second);
            service.close().await;
        })
        .await;
}
