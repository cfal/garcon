//! Joins the two provider files to the controller's executor configuration.

use std::{error::Error, path::Path, rc::Rc};

use garcon_contract::{executors::LOCAL_EXECUTOR_ID, ws_events::ApiProvidersInvalidatedMessage};
use garcon_http::{
    compose_routes::RouteMap, http_route_types::Route,
    routes::api_providers::create_api_provider_routes, ws::BrowserSockets,
};
use garcon_interface::{
    host::{AgentApiProviderReader, AgentResolveCredentialRequest, AgentResolvedCredential},
    resources::ExecutorResult,
};
use garcon_stores::{
    api_providers::{
        access::ApiProviderAccess, assignments::ApiProviderAssignmentStore,
        service::ApiProviderService, store::ApiProviderStore,
    },
    executors::config_store::ExecutorConfigStore,
    settings::SettingsStoreOptions,
};

pub(crate) use garcon_stores::api_providers::store::ApiProviderStore as ProviderProfiles;

pub(crate) struct ProviderConfiguration {
    access: Rc<ApiProviderAccess>,
}

impl ProviderConfiguration {
    pub(crate) async fn open(
        profiles: Rc<ApiProviderStore>,
        workspace: &Path,
        executors: &Rc<ExecutorConfigStore>,
    ) -> Result<Self, Box<dyn Error>> {
        let assignments = ApiProviderAssignmentStore::open(&workspace.to_string_lossy()).await?;
        assignments
            .prune(
                executors
                    .list()
                    .into_iter()
                    .map(|executor| executor.id)
                    .collect(),
            )
            .await?;
        let executors = executors.clone();
        let access = ApiProviderAccess::new(
            profiles,
            assignments,
            Rc::new(move |id| id == "local" || executors.get(id).is_some()),
        );
        Ok(Self { access })
    }

    pub(crate) fn local_credentials(&self) -> Rc<dyn AgentApiProviderReader> {
        Rc::new(LocalCredentials(self.access.clone()))
    }

    pub(crate) fn settings_options(&self) -> SettingsStoreOptions {
        let profiles = self.access.store.clone();
        SettingsStoreOptions {
            retain_provider_references: Some(Rc::new(move |next, current| {
                profiles.retain_references(next, current)
            })),
            ..Default::default()
        }
    }

    pub(crate) fn routes(self, sockets: &Rc<BrowserSockets>) -> RouteMap<Route> {
        let notify = Rc::new({
            let sockets = Rc::downgrade(sockets);
            move || {
                if let Some(sockets) = sockets.upgrade() {
                    let payload = serde_json::to_vec(&ApiProvidersInvalidatedMessage::new())?;
                    sockets.publish("chat", &payload.into());
                }
                Ok(())
            }
        });
        let _stop_profiles = self.access.store.on_changed(notify.clone());
        let _stop_assignments = self.access.assignments.on_changed(notify);
        create_api_provider_routes(ApiProviderService::new(self.access))
    }
}

struct LocalCredentials(Rc<ApiProviderAccess>);

#[async_trait::async_trait(?Send)]
impl AgentApiProviderReader for LocalCredentials {
    async fn resolve_credential(
        &self,
        request: AgentResolveCredentialRequest,
    ) -> ExecutorResult<Option<AgentResolvedCredential>> {
        if request.signal.is_cancelled() {
            return Err(garcon_base::errors::NamedError {
                name: "AbortError".into(),
                message: "The operation was aborted.".into(),
                code: None,
            }
            .into());
        }
        Ok(Some(self.0.resolve_credential(
            LOCAL_EXECUTOR_ID,
            &request.reference,
        )?))
    }
}
