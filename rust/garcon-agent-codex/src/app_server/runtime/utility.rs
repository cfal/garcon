use std::{cell::RefCell, error::Error, future::Future, rc::Rc, time::Duration};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared},
};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::json;
use tokio::{sync::Mutex, time::sleep};

use super::super::{
    client::{CodexAppServerClient, CodexAppServerEvent, shared_error},
    durability::accessible_thread_path,
    native_path_discovery_refresh::NativePathDiscoveryRefreshLimiter,
    runtime_support::is_utility_overload,
};

type Threads = Rc<IndexMap<String, Opaque>>;
type ThreadListTask = Shared<LocalBoxFuture<'static, Result<Threads, Rc<dyn Error>>>>;

struct UtilityState {
    client: Option<(u64, CodexAppServerClient)>,
    thread_lists: IndexMap<bool, (u64, ThreadListTask)>,
    refresh: NativePathDiscoveryRefreshLimiter,
    next_generation: u64,
    closed: bool,
}

struct Utility {
    create_client: Rc<dyn Fn() -> CodexAppServerClient>,
    logger: Rc<dyn AgentLogger>,
    queue: Mutex<()>,
    state: RefCell<UtilityState>,
}

#[derive(Clone)]
pub struct CodexAppServerUtility(Rc<Utility>);

impl CodexAppServerUtility {
    pub fn new(
        create_client: Rc<dyn Fn() -> CodexAppServerClient>,
        logger: Rc<dyn AgentLogger>,
        refresh: NativePathDiscoveryRefreshLimiter,
    ) -> Self {
        Self(Rc::new(Utility {
            create_client,
            logger,
            queue: Mutex::new(()),
            state: RefCell::new(UtilityState {
                client: None,
                thread_lists: IndexMap::new(),
                refresh,
                next_generation: 0,
                closed: false,
            }),
        }))
    }

    pub async fn resolve_native_path(
        &self,
        agent_session_id: Option<&str>,
    ) -> ExecutorResult<Option<String>> {
        let Some(id) = agent_session_id.filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        let threads = self.get_thread_list_cache(false).await?;
        let path = threads.get(id).and_then(|thread| thread["path"].as_str());
        Ok(accessible_thread_path(path).await.map(str::to_owned))
    }

    pub fn request_native_path_discovery_refresh(&self, agent_session_id: &str) {
        let mut state = self.0.state.borrow_mut();
        if state.refresh.accept(agent_session_id) {
            state.thread_lists.shift_remove(&false);
        }
    }

    pub fn clear_thread_list_caches(&self) {
        self.0.state.borrow_mut().thread_lists.clear();
    }

    pub async fn get_thread_list_cache(&self, use_state_db_only: bool) -> ExecutorResult<Threads> {
        let task = {
            let mut state = self.0.state.borrow_mut();
            if state.closed {
                return Err(closed_error());
            }
            if let Some((_, task)) = state.thread_lists.get(&use_state_db_only) {
                task.clone()
            } else {
                let utility = self.clone();
                let generation = state.next_generation;
                state.next_generation += 1;
                let task = async move {
                    let result = utility
                        .load_thread_list_cache(use_state_db_only)
                        .await
                        .map_err(Rc::from);
                    if result.is_err() {
                        let mut state = utility.0.state.borrow_mut();
                        if state
                            .thread_lists
                            .get(&use_state_db_only)
                            .is_some_and(|(id, _)| *id == generation)
                        {
                            state.thread_lists.shift_remove(&use_state_db_only);
                        }
                    }
                    result
                }
                .boxed_local()
                .shared();
                state
                    .thread_lists
                    .insert(use_state_db_only, (generation, task.clone()));
                tokio::task::spawn_local(task.clone());
                task
            }
        };
        task.await.map_err(shared_error)
    }

    pub async fn with_utility_client<T, Fut>(
        &self,
        mut operation: impl FnMut(CodexAppServerClient) -> Fut,
    ) -> ExecutorResult<T>
    where
        Fut: Future<Output = ExecutorResult<T>>,
    {
        let _queued = self.0.queue.lock().await;
        let mut attempt = 0;
        loop {
            let client = self.utility_client().await?;
            match operation(client).await {
                Err(error) if attempt < 3 && is_utility_overload(error.as_ref()) => {
                    attempt += 1;
                    sleep(Duration::from_millis(25 * attempt)).await;
                }
                result => return result,
            }
        }
    }

    pub async fn shutdown(&self) {
        let client = {
            let mut state = self.0.state.borrow_mut();
            state.closed = true;
            state.thread_lists.clear();
            state.client.take()
        };
        if let Some((_, client)) = client {
            let shutdown = client.shutdown().await;
            if let Err(error) = shutdown {
                self.0.logger.warn(
                    "Codex app-server shutdown failed",
                    Some(&IndexMap::from([(
                        "error".into(),
                        Opaque::from_value(json!(error.to_string())),
                    )])),
                );
            }
        }
    }

    async fn utility_client(&self) -> ExecutorResult<CodexAppServerClient> {
        let (generation, client) = {
            let mut state = self.0.state.borrow_mut();
            if state.closed {
                return Err(closed_error());
            }
            if let Some((generation, client)) = &state.client {
                (*generation, client.clone())
            } else {
                let client = (self.0.create_client)();
                let generation = state.next_generation;
                state.next_generation += 1;
                let utility = Rc::downgrade(&self.0);
                let _unsubscribe = client.on_event(Rc::new(move |event| {
                    if matches!(event, CodexAppServerEvent::Exit(_))
                        && let Some(utility) = utility.upgrade()
                    {
                        let mut state = utility.state.borrow_mut();
                        if state
                            .client
                            .as_ref()
                            .is_some_and(|(id, _)| *id == generation)
                        {
                            state.client = None;
                        }
                    }
                    Ok(())
                }));
                state.client = Some((generation, client.clone()));
                (generation, client)
            }
        };
        client.connect().await?;
        if self
            .0
            .state
            .borrow()
            .client
            .as_ref()
            .is_none_or(|(id, _)| *id != generation)
        {
            return Err(closed_error());
        }
        Ok(client)
    }

    async fn load_thread_list_cache(&self, use_state_db_only: bool) -> ExecutorResult<Threads> {
        let mut threads = IndexMap::new();
        let mut cursor = None;
        for _ in 0..20 {
            let parameters = Rc::new(ThreadListRequest {
                cursor,
                limit: 500,
                sort_key: "updated_at",
                sort_direction: "desc",
                archived: false,
                use_state_db_only,
            });
            let response = self
                .with_utility_client(|client| {
                    let parameters = parameters.clone();
                    async move {
                        client
                            .request("thread/list", Some(&*parameters), None)
                            .await
                    }
                })
                .await?;
            if let Some(page) = response["data"].as_array() {
                for thread in page {
                    if let Some(id) = thread["id"].as_str() {
                        threads.insert(id.into(), Opaque::from_value(thread.clone()));
                    }
                }
            }
            cursor = response["nextCursor"]
                .as_str()
                .filter(|cursor| !cursor.is_empty())
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(Rc::new(threads))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListRequest {
    cursor: Option<String>,
    limit: u16,
    sort_key: &'static str,
    sort_direction: &'static str,
    archived: bool,
    use_state_db_only: bool,
}

fn closed_error() -> Box<dyn Error> {
    Box::new(std::io::Error::other(
        "Codex app-server client is shut down",
    ))
}
