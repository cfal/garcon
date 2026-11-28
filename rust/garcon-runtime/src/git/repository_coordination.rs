//! Ports `server/runtime/git/repository-coordination.ts`.

use std::future::Future;
use std::rc::Rc;

use garcon_base::keyed_lock::KeyedLock;
use garcon_base::path_boundary::realpath;
use garcon_interface::resources::ExecutorResult;

use super::operation_context::{git_operation_signal, settle_git_processes};
use super::worktree_layout::probe_worktree_layout;

thread_local! {
    static MUTATIONS: Rc<KeyedLock> = Rc::new(KeyedLock::new());
}

tokio::task_local! {
    static HELD_REPOSITORY: String;
}

pub async fn with_repository_mutation<T, Fut>(
    project_path: &str,
    operation: impl FnOnce() -> Fut,
) -> ExecutorResult<T>
where
    Fut: Future<Output = ExecutorResult<T>>,
{
    let layout = probe_worktree_layout(project_path, None).await;
    let common_dir = layout
        .as_ref()
        .map_or(project_path, |layout| &layout.common_dir);
    let key = realpath(common_dir).await?.to_string_lossy().into_owned();
    if HELD_REPOSITORY
        .try_with(|held| held == &key)
        .unwrap_or(false)
    {
        return operation().await;
    }
    let lock = MUTATIONS.with(Rc::clone);
    let signal = git_operation_signal();
    lock.run_exclusive(
        &key,
        || {
            HELD_REPOSITORY.scope(key.clone(), async move {
                let result = operation().await;
                settle_git_processes().await;
                result
            })
        },
        signal.as_ref(),
    )
    .await?
}
