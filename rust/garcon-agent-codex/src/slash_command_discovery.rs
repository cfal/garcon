use std::{cell::RefCell, collections::HashSet, error::Error, rc::Rc, time::Duration};

use futures::{
    FutureExt,
    future::{LocalBoxFuture, Shared, join_all},
};
use garcon_contract::slash_commands::{SlashCommand, SlashCommandSource};
use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::{collation::Collation, json::Opaque};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::time::Instant;

use crate::app_server::client::{CodexAppServerClient, shared_error};

const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const EMPTY_CACHE_TTL: Duration = Duration::from_secs(5);
const LIST_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexSkillRef {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

struct CacheEntry {
    commands: Vec<SlashCommand>,
    skills: Vec<CodexSkillRef>,
    expires_at: Instant,
}

type ProbeTask = Shared<LocalBoxFuture<'static, Result<Rc<CacheEntry>, Rc<dyn Error>>>>;

#[derive(Default)]
struct DiscoveryState {
    cache: IndexMap<String, Rc<CacheEntry>>,
    in_flight: IndexMap<String, (u64, ProbeTask)>,
    active_clients: IndexMap<u64, CodexAppServerClient>,
    generation: u64,
    next_probe: u64,
}

struct Discovery {
    create_client: Rc<dyn Fn() -> CodexAppServerClient>,
    logger: Rc<dyn AgentLogger>,
    state: RefCell<DiscoveryState>,
}

#[derive(Clone)]
pub struct CodexSkillDiscovery(Rc<Discovery>);

impl CodexSkillDiscovery {
    pub fn new(
        create_client: Rc<dyn Fn() -> CodexAppServerClient>,
        logger: Rc<dyn AgentLogger>,
    ) -> Self {
        Self(Rc::new(Discovery {
            create_client,
            logger,
            state: RefCell::new(DiscoveryState::default()),
        }))
    }

    pub async fn commands(&self, project_path: &str) -> ExecutorResult<Vec<SlashCommand>> {
        Ok(self.ensure(project_path).await?.commands.clone())
    }

    pub async fn skill_refs(&self, project_path: &str) -> ExecutorResult<Vec<CodexSkillRef>> {
        Ok(self.ensure(project_path).await?.skills.clone())
    }

    pub async fn clear(&self) {
        let clients = {
            let mut state = self.0.state.borrow_mut();
            state.cache.clear();
            state.in_flight.clear();
            state.generation += 1;
            std::mem::take(&mut state.active_clients)
        };
        let results = join_all(clients.values().map(CodexAppServerClient::shutdown)).await;
        for result in results {
            if let Err(error) = result {
                self.0.logger.warn(
                    "Codex app-server shutdown failed",
                    Some(&IndexMap::from([
                        (
                            "operation".into(),
                            Opaque::from_value(json!("skills-discovery-clear")),
                        ),
                        ("error".into(), Opaque::from_value(json!(error.to_string()))),
                    ])),
                );
            }
        }
    }

    async fn ensure(&self, project_path: &str) -> ExecutorResult<Rc<CacheEntry>> {
        let task = {
            let mut state = self.0.state.borrow_mut();
            if let Some(cached) = state.cache.get(project_path)
                && cached.expires_at > Instant::now()
            {
                return Ok(cached.clone());
            }
            if let Some((_, task)) = state.in_flight.get(project_path) {
                task.clone()
            } else {
                let generation = state.generation;
                let probe = state.next_probe;
                state.next_probe += 1;
                let discovery = self.clone();
                let path = project_path.to_owned();
                let client = (self.0.create_client)();
                state.active_clients.insert(probe, client.clone());
                let task = async move {
                    let result = discovery
                        .probe(probe, &path, &client)
                        .await
                        .map(cache_entry);
                    let mut state = discovery.0.state.borrow_mut();
                    if let Ok(entry) = &result
                        && state.generation == generation
                    {
                        state.cache.insert(path.clone(), entry.clone());
                    }
                    if state
                        .in_flight
                        .get(&path)
                        .is_some_and(|(id, _)| *id == probe)
                    {
                        state.in_flight.shift_remove(&path);
                    }
                    result.map_err(Rc::from)
                }
                .boxed_local()
                .shared();
                state
                    .in_flight
                    .insert(project_path.into(), (probe, task.clone()));
                tokio::task::spawn_local(task.clone());
                task
            }
        };
        task.await.map_err(shared_error)
    }

    async fn probe(
        &self,
        probe: u64,
        project_path: &str,
        client: &CodexAppServerClient,
    ) -> ExecutorResult<Vec<CodexSkillRef>> {
        let params = json!({"cwds": [project_path]});
        let result = match tokio::time::timeout(
            LIST_TIMEOUT,
            client.request("skills/list", Some(&params), None),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => Err(std::io::Error::other("skills/list timed out").into()),
        };
        let skills = match result {
            Ok(response) => parse_skills_list_response(&response),
            Err(error) => {
                self.0.logger.warn(
                    "Codex skills discovery failed",
                    Some(&IndexMap::from([
                        (
                            "projectPath".into(),
                            Opaque::from_value(json!(project_path)),
                        ),
                        ("error".into(), Opaque::from_value(json!(error.to_string()))),
                    ])),
                );
                Vec::new()
            }
        };
        self.0
            .state
            .borrow_mut()
            .active_clients
            .shift_remove(&probe);
        client.shutdown().await?;
        Ok(skills)
    }
}

fn cache_entry(skills: Vec<CodexSkillRef>) -> Rc<CacheEntry> {
    let ttl = if skills.is_empty() {
        EMPTY_CACHE_TTL
    } else {
        CACHE_TTL
    };
    Rc::new(CacheEntry {
        commands: skills
            .iter()
            .map(|skill| SlashCommand {
                name: skill.name.clone(),
                source: SlashCommandSource::Skill,
                description: skill.description.clone(),
            })
            .collect(),
        skills,
        expires_at: Instant::now() + ttl,
    })
}

pub fn parse_skills_list_response(response: &Value) -> Vec<CodexSkillRef> {
    let Some(data) = response.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut refs = Vec::new();
    let mut seen = HashSet::new();
    for skill in data
        .iter()
        .filter_map(|entry| entry.get("skills").and_then(Value::as_array))
        .flatten()
    {
        if skill["enabled"].as_bool() == Some(false) {
            continue;
        }
        let (Some(name), Some(path)) = (skill["name"].as_str(), skill["path"].as_str()) else {
            continue;
        };
        if name.is_empty() || path.is_empty() || !seen.insert(name) {
            continue;
        }
        refs.push(CodexSkillRef {
            name: name.into(),
            path: path.into(),
            description: skill["description"]
                .as_str()
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
        });
    }
    refs.sort_by(|left, right| Collation::english().compare(&left.name, &right.name));
    refs
}
