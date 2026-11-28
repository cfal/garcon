//! Bounded admission that waits for admitted work to settle after failure.

use std::future::Future;

use futures::{StreamExt, stream::FuturesUnordered};
use garcon_js::is_integer;

#[derive(Debug, thiserror::Error)]
pub enum ConcurrencyError<E> {
    #[error("Concurrency limit must be a positive integer")]
    InvalidLimit,
    #[error(transparent)]
    Work(E),
}

pub async fn map_with_concurrency<T, E, F>(
    items: &[T],
    limit: f64,
    worker: impl Fn(&T) -> F,
) -> Result<(), ConcurrencyError<E>>
where
    F: Future<Output = Result<(), E>>,
{
    map_with_concurrency_result(items, limit, |item, _| worker(item))
        .await
        .map(drop)
}

pub async fn map_with_concurrency_result<T, R, E, F>(
    items: &[T],
    limit: f64,
    worker: impl Fn(&T, usize) -> F,
) -> Result<Vec<R>, ConcurrencyError<E>>
where
    F: Future<Output = Result<R, E>>,
{
    if !is_integer(limit) || limit < 1.0 {
        return Err(ConcurrencyError::InvalidLimit);
    }
    tokio::task::yield_now().await;
    let concurrent = (limit as usize).min(items.len());
    let mut next = items.iter().enumerate();
    let mut pending = FuturesUnordered::new();
    let mut results: Vec<Option<R>> = (0..items.len()).map(|_| None).collect();
    let run = |(index, item)| {
        let work = worker(item, index);
        async move { (index, work.await) }
    };
    for item in next.by_ref().take(concurrent) {
        pending.push(run(item));
    }
    let mut failure = None;
    while let Some((index, result)) = pending.next().await {
        match result {
            Ok(result) => results[index] = Some(result),
            Err(error) => {
                failure.get_or_insert(error);
            }
        }
        if failure.is_none()
            && let Some(item) = next.next()
        {
            pending.push(run(item));
        }
    }
    if let Some(error) = failure {
        return Err(ConcurrencyError::Work(error));
    }
    // INFALLIBLE: no worker failed, so each result slot was filled.
    Ok(results
        .into_iter()
        .map(|result| result.expect("settled worker"))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;
    use tokio::{sync::Notify, task::LocalSet, time};

    #[tokio::test]
    async fn stops_admitting_on_failure_but_does_not_release_started_work() {
        LocalSet::new()
            .run_until(async {
                let started = Rc::new(RefCell::new(Vec::new()));
                let held = Rc::new(Notify::new());
                let sibling_started = Rc::new(Notify::new());
                let active = {
                    let (started, held, sibling_started) = (
                        Rc::clone(&started),
                        Rc::clone(&held),
                        Rc::clone(&sibling_started),
                    );
                    tokio::task::spawn_local(async move {
                        map_with_concurrency(&[0, 1, 2, 3], 2.0, |&item| {
                            let (started, held, sibling_started) = (
                                Rc::clone(&started),
                                Rc::clone(&held),
                                Rc::clone(&sibling_started),
                            );
                            async move {
                                started.borrow_mut().push(item);
                                if item == 0 {
                                    return Err("synthetic failure");
                                }
                                sibling_started.notify_one();
                                held.notified().await;
                                Ok(())
                            }
                        })
                        .await
                    })
                };
                sibling_started.notified().await;
                assert_eq!(*started.borrow(), [0, 1]);
                assert!(!active.is_finished());
                held.notify_one();
                assert!(matches!(
                    active.await.unwrap(),
                    Err(ConcurrencyError::Work("synthetic failure"))
                ));
                assert_eq!(*started.borrow(), [0, 1]);
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn bounds_active_workers_and_orders_results_by_input() {
        let active = Cell::new(0);
        let maximum = Cell::new(0);
        let result = map_with_concurrency_result(&[3, 2, 1, 0, 4], 2.0, |&value, _| {
            let (active, maximum) = (&active, &maximum);
            async move {
                active.set(active.get() + 1);
                maximum.set(maximum.get().max(active.get()));
                time::sleep(time::Duration::from_millis(value)).await;
                active.set(active.get() - 1);
                Ok::<_, std::io::Error>(value * 2)
            }
        })
        .await
        .unwrap();
        assert_eq!(maximum.get(), 2);
        assert_eq!(active.get(), 0);
        assert_eq!(result, [6, 4, 2, 0, 8]);
        for invalid in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY] {
            assert!(matches!(
                map_with_concurrency(&[], invalid, |_: &i32| async {
                    Ok::<_, std::io::Error>(())
                })
                .await,
                Err(ConcurrencyError::InvalidLimit)
            ));
        }
    }
}
