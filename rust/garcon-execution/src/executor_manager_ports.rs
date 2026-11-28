//! Defines what ExecutorManager needs from the remote client.
//! The manager owns the configured link, readiness of the installed
//! integration registry, and reverse-call authority. The client owns
//! session installation, inventory, and reconnect/bulk state.

use std::rc::Rc;

use garcon_base::log::Logger;
use garcon_contract::executors::ExecutorBulkStatus;
use garcon_interface::execution_runtime::ExecutionRuntimeApi;
use garcon_link::{
    rpc::ExecutorRpc, rpc_connection::RpcConnectionDiagnostics, rpc_protocol::IntegrationManifest,
    websocket_link::WebSocketLink,
};

use crate::types::ExecutionOperationResult;

#[derive(Debug, Clone, PartialEq)]
pub struct RemoteExecutorInventory {
    pub integrations: Vec<IntegrationManifest>,
}

pub type RemoteBulkListener = Rc<dyn Fn(ExecutorBulkStatus)>;
pub type BindReverseRequests = Rc<dyn Fn(Rc<ExecutorRpc>)>;
pub type ReportRemoteSetupError = Rc<dyn Fn(&str)>;

pub struct CreateRemoteExecutor {
    pub executor_id: String,
    pub link: Rc<WebSocketLink>,
    /// Installs the manager's reverse handler on each authenticated primary
    /// or bulk endpoint before it accepts calls.
    pub bind_reverse_requests: BindReverseRequests,
    pub report_setup_error: ReportRemoteSetupError,
    pub previous_inventory: Option<RemoteExecutorInventory>,
    pub logger: Rc<dyn Logger>,
}

pub trait ManagedRemoteExecutor: ExecutionRuntimeApi {
    fn inventory(&self) -> Option<RemoteExecutorInventory>;
    fn bulk_status(&self) -> ExecutorBulkStatus;
    fn on_bulk_changed(&self, listener: RemoteBulkListener) -> Box<dyn Fn()>;
    fn diagnostics(&self) -> Option<RpcConnectionDiagnostics>;
}

pub trait RemoteExecutorFactory {
    fn create(
        &self,
        options: CreateRemoteExecutor,
    ) -> ExecutionOperationResult<Rc<dyn ManagedRemoteExecutor>>;
}
