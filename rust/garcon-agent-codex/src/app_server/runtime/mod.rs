pub mod thread_settings;
pub mod utility;

use std::rc::Rc;

use garcon_interface::{host::AgentLogger, resources::ExecutorResult};
use garcon_js::{Number, json::Opaque};
use indexmap::IndexMap;
use serde_json::{Value, json};

use super::{
    client::{CodexAppServerClient, CodexAppServerEvent},
    protocol::JsonRpcServerRequest,
    runtime_support::denial_response_for_request,
};

fn wire_client(
    client: &CodexAppServerClient,
    logger: Rc<dyn AgentLogger>,
    dispatch: impl Fn(&CodexAppServerClient, &CodexAppServerEvent) -> ExecutorResult<()> + 'static,
) {
    client.on_event_with_client(move |client, event| match event {
        CodexAppServerEvent::Stderr(_) => {
            logger.warn("Codex app-server stderr", None);
            Ok(())
        }
        CodexAppServerEvent::Warning(message) => {
            logger.warn(message, None);
            Ok(())
        }
        _ => dispatch(client, event),
    });
}

fn reject_unsupported_request(
    client: &CodexAppServerClient,
    request: &JsonRpcServerRequest,
) -> ExecutorResult<()> {
    client.reject(
        &request.id,
        Number(-32601.0),
        &format!("Unsupported Codex app-server request: {}", request.method),
    )
}

fn deny_unowned_approval(
    client: &CodexAppServerClient,
    logger: &dyn AgentLogger,
    request: &JsonRpcServerRequest,
) -> ExecutorResult<()> {
    let params = request.params.as_deref();
    let field = |key| {
        params
            .and_then(|params| params.get(key))
            .and_then(Value::as_str)
    };
    logger.warn(
        "Dropped an unowned Codex approval request",
        Some(&IndexMap::from([
            (
                "threadId".into(),
                Opaque::from_value(json!(field("threadId").or_else(|| field("conversationId")))),
            ),
            (
                "nativeTurnId".into(),
                Opaque::from_value(json!(field("turnId"))),
            ),
            ("method".into(), Opaque::from_value(json!(request.method))),
        ])),
    );
    client.respond(
        &request.id,
        &denial_response_for_request(&request.method, params),
    )
}
