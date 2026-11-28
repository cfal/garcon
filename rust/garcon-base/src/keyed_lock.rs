use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::rc::Rc;

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("The operation was aborted.")]
pub struct LockAborted;

impl LockAborted {
    pub const NAME: &'static str = "AbortError";
}

#[derive(Default)]
pub struct KeyedLock {
    locks: RefCell<HashMap<String, Rc<Mutex<()>>>>,
}

impl KeyedLock {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn run_exclusive<T, F, Fut>(
        &self,
        key: &str,
        work: F,
        signal: Option<&CancellationToken>,
    ) -> Result<T, LockAborted>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(LockAborted);
        }
        let entry = self.entry(key);
        let _guard = if let Some(signal) = signal {
            tokio::select! {
                biased;
                () = signal.cancelled() => return Err(LockAborted),
                guard = entry.mutex.lock() => guard,
            }
        } else {
            entry.mutex.lock().await
        };
        if signal.is_some_and(CancellationToken::is_cancelled) {
            return Err(LockAborted);
        }
        Ok(work().await)
    }

    /// Returns the signal owner's original reason rather than a default AbortError.
    pub async fn run_exclusive_with_abort_reason<T, F, Fut, E>(
        &self,
        key: &str,
        work: F,
        signal: &CancellationToken,
        reason: impl FnOnce() -> E,
    ) -> Result<T, E>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        self.run_exclusive(key, work, Some(signal))
            .await
            .map_err(|_| reason())
    }

    pub async fn run_exclusive_many<T, F, Fut>(&self, keys: &[&str], work: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        let mut keys = keys.to_vec();
        keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        keys.dedup();
        self.acquire_many(&keys, work).await
    }

    async fn acquire_many<T, F, Fut>(&self, keys: &[&str], work: F) -> T
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = T>,
    {
        if let Some((key, rest)) = keys.split_first() {
            let entry = self.entry(key);
            let _guard = entry.mutex.lock().await;
            Box::pin(self.acquire_many(rest, work)).await
        } else {
            work().await
        }
    }

    fn entry<'a>(&'a self, key: &'a str) -> Entry<'a> {
        let mutex = Rc::clone(self.locks.borrow_mut().entry(key.into()).or_default());
        Entry {
            owner: self,
            key,
            mutex,
        }
    }
}

struct Entry<'a> {
    owner: &'a KeyedLock,
    key: &'a str,
    mutex: Rc<Mutex<()>>,
}

impl Drop for Entry<'_> {
    fn drop(&mut self) {
        if Rc::strong_count(&self.mutex) == 2 {
            self.owner.locks.borrow_mut().remove(self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn a_default_abort_has_buns_message() {
        let signal = CancellationToken::new();
        signal.cancel();
        let error = KeyedLock::new()
            .run_exclusive("repo", || async {}, Some(&signal))
            .await
            .unwrap_err();
        assert_eq!(LockAborted::NAME, "AbortError");
        assert_eq!(error.to_string(), "The operation was aborted.");
    }

    #[tokio::test]
    async fn forwards_the_callers_abort_reason_unchanged() {
        let lock = KeyedLock::new();
        let signal = CancellationToken::new();
        assert_eq!(
            lock.run_exclusive_with_abort_reason(
                "repo",
                || async { "acquired" },
                &signal,
                || {
                    panic!("a reason must not be read on success");
                }
            )
            .await,
            Ok::<_, Rc<String>>("acquired"),
        );

        let custom = Rc::new("synthetic reason".to_owned());
        let (release, hold) = oneshot::channel();
        let owner = lock.run_exclusive("repo", || async { hold.await.unwrap() }, None);
        let cancelled = async {
            let work = lock.run_exclusive_with_abort_reason(
                "repo",
                || async {},
                &signal,
                || Rc::clone(&custom),
            );
            let signal_while_waiting = async {
                tokio::task::yield_now().await;
                signal.cancel();
            };
            let (result, ()) = tokio::join!(work, signal_while_waiting);
            let reason = result.unwrap_err();
            assert!(Rc::ptr_eq(&reason, &custom));
            release.send(()).unwrap();
        };
        let (owner, ()) = tokio::join!(owner, cancelled);
        assert!(owner.is_ok());
    }

    #[tokio::test]
    async fn deduplicates_and_sorts_keys_before_acquisition() {
        let lock = KeyedLock::new();
        let sequence = RefCell::new(Vec::new());
        let (entered, wait) = oneshot::channel();
        let (release, hold) = oneshot::channel();
        let owner = lock.run_exclusive(
            "a",
            || async {
                entered.send(()).unwrap();
                hold.await.unwrap();
            },
            None,
        );
        let first = async {
            wait.await.unwrap();
            lock.run_exclusive_many(&["b", "a", "a"], || async {
                sequence.borrow_mut().push("first");
            })
            .await;
        };
        let independent = async {
            tokio::task::yield_now().await;
            lock.run_exclusive_many(&["b"], || async {
                sequence.borrow_mut().push("independent");
            })
            .await;
            release.send(()).unwrap();
        };
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            let (result, (), ()) = tokio::join!(owner, first, independent);
            assert_eq!(result, Ok(()));
        })
        .await
        .unwrap();
        assert_eq!(sequence.into_inner(), ["independent", "first"]);
        assert!(lock.locks.borrow().is_empty());
    }

    #[tokio::test]
    async fn releases_every_key_after_rejection_without_blocking_independent_keys() {
        let lock = KeyedLock::new();
        let (entered, wait) = oneshot::channel();
        let (release, hold) = oneshot::channel();
        let failing = lock.run_exclusive_many(&["b", "a"], || async {
            entered.send(()).unwrap();
            hold.await.unwrap();
            Err::<(), _>("synthetic failure")
        });
        let independent = async {
            wait.await.unwrap();
            assert_eq!(
                lock.run_exclusive_many(&["c"], || async { "independent" })
                    .await,
                "independent"
            );
            release.send(()).unwrap();
        };
        let (failed, ()) = tokio::join!(failing, independent);
        assert_eq!(failed, Err("synthetic failure"));
        assert!(lock.locks.borrow().is_empty());
        assert_eq!(
            lock.run_exclusive_many(&[], || async { "empty" }).await,
            "empty"
        );
    }

    #[tokio::test]
    async fn removes_aborted_waiters_without_releasing_their_active_owner() {
        let lock = KeyedLock::new();
        let (release, hold) = oneshot::channel();
        let signal = CancellationToken::new();
        let ran = Cell::new(false);
        let owner = lock.run_exclusive("repo", || async { hold.await.unwrap() }, None);
        let waiter = async {
            tokio::task::yield_now().await;
            lock.run_exclusive("repo", || async { ran.set(true) }, Some(&signal))
                .await
        };
        let controller = async {
            while lock
                .locks
                .borrow()
                .get("repo")
                .is_none_or(|entry| Rc::strong_count(entry) < 3)
            {
                tokio::task::yield_now().await;
            }
            signal.cancel();
            tokio::task::yield_now().await;
            assert!(!ran.get());
            release.send(()).unwrap();
        };
        let (owner_result, waiter_result, ()) = tokio::join!(owner, waiter, controller);
        assert_eq!(owner_result, Ok(()));
        assert_eq!(waiter_result, Err(LockAborted));
        assert!(lock.locks.borrow().is_empty());
        assert!(!ran.get());
        assert_eq!(
            lock.run_exclusive("repo", || async { "released" }, None)
                .await,
            Ok("released")
        );
    }
}
