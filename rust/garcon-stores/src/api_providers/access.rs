//! Authorizes provider access for the executor established by the caller.

use std::rc::Rc;

use garcon_base::domain_error::{DomainError, as_domain_error};
use garcon_contract::{
    agent_execution::AgentCredentialReference, api_providers::is_api_provider_id,
    error_codes::ErrorCode, executors::is_executor_id,
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationErrorCode},
    host::AgentResolvedCredential,
};
use garcon_js::is_safe_integer;
use serde_json::Value;

use super::Result;
use super::assignments::{
    ApiProviderAssignmentStore, AssertAssignmentCurrent, RetainExecutorReferences,
};
use super::store::{
    ApiProviderStore, StoredApiProvider, StoredApiProviderEndpoint, configuration_changed,
};

pub struct ApiProviderAccess {
    pub store: Rc<ApiProviderStore>,
    pub assignments: Rc<ApiProviderAssignmentStore>,
    executor_exists: Rc<dyn Fn(&str) -> bool>,
}

impl ApiProviderAccess {
    pub fn new(
        store: Rc<ApiProviderStore>,
        assignments: Rc<ApiProviderAssignmentStore>,
        executor_exists: Rc<dyn Fn(&str) -> bool>,
    ) -> Rc<Self> {
        Rc::new(Self {
            store,
            assignments,
            executor_exists,
        })
    }

    pub fn assert_executor(&self, id: &str) -> Result<()> {
        if !is_executor_id(&Value::String(id.into())) || !(self.executor_exists)(id) {
            return Err(DomainError::new(
                ErrorCode::EXECUTOR_NOT_FOUND,
                "Executor not found",
                404,
                false,
            )
            .into());
        }
        Ok(())
    }

    pub fn list(&self, executor: &str) -> Result<Vec<StoredApiProvider>> {
        self.assert_executor(executor)?;
        let mut available = Vec::new();
        for profile in self.store.list()? {
            if self.assignments.allows(executor, &profile.id)? {
                available.push(profile);
            }
        }
        Ok(available)
    }

    pub fn require(
        &self,
        executor: &str,
        provider: &str,
        endpoint: Option<&str>,
        revision: Option<i64>,
    ) -> Result<(StoredApiProvider, StoredApiProviderEndpoint)> {
        self.assert_executor(executor)?;
        let unavailable = || {
            DomainError::new(
                ErrorCode::API_PROVIDER_UNAVAILABLE,
                "This provider is unavailable on the selected executor.",
                409,
                false,
            )
        };
        let profile = self
            .store
            .get_api_provider(provider)?
            .ok_or_else(unavailable)?;
        if !self.assignments.allows(executor, provider)? {
            return Err(unavailable().into());
        }
        if revision.is_some_and(|revision| revision != profile.revision) {
            return Err(DomainError::new(
                ErrorCode::API_PROVIDER_CONFIGURATION_CHANGED,
                "Provider configuration changed. Refresh and try again.",
                409,
                false,
            )
            .into());
        }
        let selected = match endpoint.filter(|id| !id.is_empty()) {
            Some(id) => profile.endpoints.iter().find(|endpoint| endpoint.id == id),
            None => profile.endpoints.first(),
        }
        .cloned()
        .ok_or_else(|| {
            DomainError::new(
                ErrorCode::API_PROVIDER_UNAVAILABLE,
                "The endpoint does not belong to this provider.",
                409,
                false,
            )
        })?;
        Ok((profile, selected))
    }

    pub fn resolve_credential(
        &self,
        executor: &str,
        reference: &AgentCredentialReference,
    ) -> Result<AgentResolvedCredential> {
        if !is_valid_id(&reference.api_provider_id)
            || !is_valid_id(&reference.endpoint_id)
            || reference.revision < 1
            || !is_safe_integer(reference.revision as f64)
        {
            return Err(AgentCallError::with_code(
                AgentDeliveryOutcome::Rejected,
                "Invalid provider credential reference",
                AgentIntegrationErrorCode::INVALID_ENDPOINT,
            )
            .into());
        }
        let (_, endpoint) = self
            .require(
                executor,
                &reference.api_provider_id,
                Some(&reference.endpoint_id),
                Some(reference.revision),
            )
            .map_err(credential_error)?;
        Ok(AgentResolvedCredential {
            kind: "api-key".into(),
            value: endpoint.api_key,
        })
    }

    pub async fn assign(
        self: &Rc<Self>,
        executor: String,
        provider: String,
        retain: RetainExecutorReferences,
        assert_current: Option<AssertAssignmentCurrent>,
    ) -> Result<()> {
        let access = self.clone();
        self.store
            .with_lock(move |store| async move {
                access.assert_executor(&executor)?;
                if !is_valid_id(&provider) || store.get_api_provider(&provider)?.is_none() {
                    return Err(provider_not_found().into());
                }
                access
                    .assignments
                    .assign(executor, provider, retain, assert_current)
                    .await
            })
            .await
    }

    pub async fn set_assignments(
        self: &Rc<Self>,
        provider: String,
        executors: Vec<String>,
        revision: i64,
        retain: RetainExecutorReferences,
    ) -> Result<()> {
        let access = self.clone();
        self.store
            .with_lock(move |store| async move {
                for executor in &executors {
                    access.assert_executor(executor)?;
                }
                let profile = store
                    .get_api_provider(&provider)?
                    .ok_or_else(provider_not_found)?;
                if profile.revision != revision {
                    return Err(configuration_changed().into());
                }
                access
                    .assignments
                    .set_provider_executors(provider, executors, retain)
                    .await
            })
            .await
    }

    pub async fn unassign(
        self: &Rc<Self>,
        executor: String,
        provider: String,
        retain: RetainExecutorReferences,
        assert_current: Option<AssertAssignmentCurrent>,
    ) -> Result<()> {
        let access = self.clone();
        self.store
            .with_lock(move |_| async move {
                access.assert_executor(&executor)?;
                access
                    .assignments
                    .unassign(executor, provider, retain, assert_current)
                    .await
            })
            .await
    }
}

pub(super) fn provider_not_found() -> DomainError {
    DomainError::new(
        ErrorCode::API_PROVIDER_UNAVAILABLE,
        "Provider not found",
        404,
        false,
    )
}

fn is_valid_id(id: &str) -> bool {
    is_api_provider_id(&Value::String(id.into()))
}

fn credential_error(error: super::BoxError) -> super::BoxError {
    let Some(domain) = as_domain_error(error.as_ref()) else {
        return error;
    };
    let code = match domain.code {
        ErrorCode::API_PROVIDER_CONFIGURATION_CHANGED => {
            AgentIntegrationErrorCode::API_PROVIDER_CONFIGURATION_CHANGED
        }
        ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE => {
            AgentIntegrationErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE
        }
        ErrorCode::VALIDATION_FAILED => AgentIntegrationErrorCode::INVALID_ENDPOINT,
        _ => AgentIntegrationErrorCode::API_PROVIDER_UNAVAILABLE,
    };
    AgentCallError::with_code(AgentDeliveryOutcome::Rejected, domain.message.clone(), code).into()
}
