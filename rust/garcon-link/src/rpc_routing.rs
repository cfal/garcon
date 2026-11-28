//! Ports `server/remote/transport/rpc-routing.ts`.

use std::error::Error;

use garcon_base::domain_error::DomainError;
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode};
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use serde_json::Value;

use crate::cli_protocol::{cli_policy, parse_controller_cli_request};
use crate::git_protocol::is_git_rpc_method;
use crate::limits::PRIMARY_SMALL_RPC_BYTES;
use crate::rpc_lane::RpcLane;

type RoutingError = Box<dyn Error>;

pub fn rpc_lane(
    method: &str,
    request: &Value,
    calling_lane: RpcLane,
) -> Result<RpcLane, RoutingError> {
    use RpcLane::{Bulk, Primary};
    if is_git_rpc_method(method) {
        return Ok(if method == "git.getQuickSummary" {
            Primary
        } else {
            Bulk
        });
    }
    let lane = match method {
        "calls.reconcile" => calling_lane,
        "controllerCli.request" => {
            parse_controller_cli_request(request)?
                .http
                .operation
                .policy()
                .lane
        }
        "executor.describe"
        | "apiProviders.discoverModels"
        | "projects.inspect"
        | "projects.ticketProjectDefault"
        | "projects.resolveFileMentions"
        | "producers.bind"
        | "producers.close"
        | "producers.cancelLaunch"
        | "producers.resume"
        | "permissions.respond"
        | "execution.start"
        | "execution.resume"
        | "execution.abort"
        | "execution.runningSessions"
        | "catalog.snapshot"
        | "settings.migrate"
        | "lifecycle.start"
        | "lifecycle.stop"
        | "lifecycle.migrateOwnedStorage"
        | "migration.translateLegacyModel"
        | "migration.translateLegacyNativeSession"
        | "migration.translateLegacySettings"
        | "auth.status"
        | "readiness.status"
        | "auth.launchLogin"
        | "auth.completeLogin"
        | "auth.loginStatus"
        | "commands.discover"
        | "compaction.compact"
        | "forking.fork"
        | "forking.discard"
        | "steering.captureTarget"
        | "steering.steer"
        | "endpoints.validate"
        | "singleQuery.run"
        | "nativeActivity.lastActivity"
        | "nativeSessions.resolveNativeSession"
        | "nativeSessions.describeSource"
        | "nativeSessions.release"
        | "configurationValidation.validate"
        | "sessionConfiguration.apply"
        | "projectPathUpdates.prepare"
        | "projectPathUpdates.commit"
        | "projectPathUpdates.rollback"
        | "cliUpdates.status"
        | "cliUpdates.startUpdate"
        | "credentials.resolve"
        | "terminals.list"
        | "terminals.create"
        | "terminals.rename"
        | "terminals.terminate"
        | "terminals.attach"
        | "terminals.input"
        | "terminals.resize"
        | "terminals.detach"
        | "controllerCli.describe"
        | "files.identity"
        | "files.revision" => Primary,
        "history.open"
        | "history.next"
        | "history.close"
        | "usageHistory.read"
        | "files.tree"
        | "files.browse"
        | "files.list"
        | "files.read"
        | "files.save"
        | "files.createDirectory" => Bulk,
        _ => {
            return Err(Box::new(AgentCallError::new(
                AgentDeliveryOutcome::Rejected,
                "Unknown executor RPC method",
            )));
        }
    };
    Ok(lane)
}

pub fn assert_rpc_lane(method: &str, request: &Value, lane: RpcLane) -> Result<(), RoutingError> {
    if rpc_lane(method, request, lane)? != lane {
        return Err(Box::new(AgentCallError::new(
            AgentDeliveryOutcome::NotDispatched,
            "Executor request arrived on the wrong lane",
        )));
    }
    Ok(())
}

pub fn assert_rpc_request_size(
    method: &str,
    lane: RpcLane,
    bytes: usize,
) -> Result<(), RoutingError> {
    if lane != RpcLane::Primary || bytes <= PRIMARY_SMALL_RPC_BYTES {
        return Ok(());
    }
    match method {
        "git.getQuickSummary" => Err(Box::new(GitServiceError::new(
            GitServiceErrorCode::GIT_REQUEST_TOO_LARGE,
            "Git summary request exceeds 64 KiB",
        ))),
        "controllerCli.request" | "controllerCli.describe" => Err(Box::new(DomainError::new(
            ErrorCode::CLI_REQUEST_TOO_LARGE,
            "Primary CLI request exceeds 64 KiB",
            413,
            false,
        ))),
        _ => Ok(()),
    }
}

pub fn assert_rpc_reply_size(
    method: &str,
    request: &Value,
    lane: RpcLane,
    bytes: usize,
) -> Result<(), RoutingError> {
    if lane != RpcLane::Primary || bytes <= PRIMARY_SMALL_RPC_BYTES {
        return Ok(());
    }
    match method {
        "git.getQuickSummary" => Err(Box::new(GitServiceError::new(
            GitServiceErrorCode::GIT_RESULT_TOO_LARGE,
            "Git summary result exceeds 64 KiB",
        ))),
        "controllerCli.request" | "controllerCli.describe" => {
            let mutating = if method == "controllerCli.request" {
                let http = parse_controller_cli_request(request)?.http;
                cli_policy(http.operation, &http.body).mutation
            } else {
                false
            };
            if mutating {
                return Err(Box::new(DomainError::new(
                    ErrorCode::CLI_OUTCOME_UNKNOWN,
                    "Primary CLI mutation reply exceeded 64 KiB; its outcome is unknown",
                    503,
                    false,
                )));
            }
            Err(Box::new(DomainError::new(
                ErrorCode::CLI_RESULT_TOO_LARGE,
                "Primary CLI result exceeds 64 KiB",
                413,
                false,
            )))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn primary_small_call_caps_preserve_git_and_cli_mutation_error_contracts() {
        let size = PRIMARY_SMALL_RPC_BYTES + 1;
        assert!(assert_rpc_request_size("git.getQuickSummary", RpcLane::Primary, size - 1).is_ok());
        let request =
            assert_rpc_request_size("git.getQuickSummary", RpcLane::Primary, size).unwrap_err();
        assert_eq!(
            request.downcast_ref::<GitServiceError>().unwrap().code,
            GitServiceErrorCode::GIT_REQUEST_TOO_LARGE
        );
        let reply =
            assert_rpc_reply_size("git.getQuickSummary", &Value::Null, RpcLane::Primary, size)
                .unwrap_err();
        assert_eq!(
            reply.downcast_ref::<GitServiceError>().unwrap().code,
            GitServiceErrorCode::GIT_RESULT_TOO_LARGE
        );

        let stop = json!({
            "expectedServerInstanceId": "synthetic",
            "http": {"operation": "POST /api/v1/chats/stop", "query": [], "body": {}}
        });
        let reply = assert_rpc_reply_size("controllerCli.request", &stop, RpcLane::Primary, size)
            .unwrap_err();
        assert_eq!(
            reply.downcast_ref::<DomainError>().unwrap().code,
            ErrorCode::CLI_OUTCOME_UNKNOWN
        );
        assert!(assert_rpc_reply_size("controllerCli.request", &stop, RpcLane::Bulk, size).is_ok());
    }
}
