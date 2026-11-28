use std::error::Error;
use std::rc::Rc;

use garcon_base::ticket_error::validate_ticket_input;
use garcon_contract::{
    error_codes::ErrorCode,
    ticket_commands::{TicketMutationPayload, parse_http_ticket_mutation_request},
    ticket_query::ticket_query_params,
    ticket_validation::{ticket_record, ticket_string},
};
use garcon_js::json::Opaque;
use garcon_stores::tickets::{
    Facet,
    contracts::{TicketPrincipal, derive_ticket_caller},
    errors::ticket_error,
    setup::TicketRuntime,
};
use http::{Method, StatusCode};
use serde_json::Value;
use url::Url;

use crate::{
    compose_routes::RouteMap,
    http_route_types::{HttpRouteContext, Route, RouteMetadata, RouteResult, ServerPrincipal},
    listener::HttpRequest,
    ticket_http::{read_ticket_body, require_ticket_principal, ticket_error_response, ticket_json},
};

#[derive(Clone, Copy)]
enum TicketRoute {
    Bootstrap,
    List,
    Counts,
    Detail,
    Comments,
    History,
    Facets,
    Mutate,
}

pub fn create_ticket_routes(tickets: &Rc<TicketRuntime>) -> RouteMap<Route> {
    let mut routes = RouteMap::new();
    for (path, method, action) in [
        (
            "/api/v1/tickets/bootstrap",
            Method::GET,
            TicketRoute::Bootstrap,
        ),
        ("/api/v1/tickets", Method::GET, TicketRoute::List),
        ("/api/v1/tickets/counts", Method::GET, TicketRoute::Counts),
        ("/api/v1/tickets/detail", Method::GET, TicketRoute::Detail),
        (
            "/api/v1/tickets/comments",
            Method::GET,
            TicketRoute::Comments,
        ),
        ("/api/v1/tickets/history", Method::GET, TicketRoute::History),
        ("/api/v1/tickets/facets", Method::GET, TicketRoute::Facets),
        ("/api/v1/tickets/mutate", Method::POST, TicketRoute::Mutate),
    ] {
        let tickets = tickets.clone();
        let route = Route::new(
            RouteMetadata {
                no_store: true,
                ..Default::default()
            },
            move |request, url, context| {
                let tickets = tickets.clone();
                async move {
                    match handle(&tickets, action, request, &url, &context).await {
                        Ok(reply) => Ok(reply),
                        Err(error) => ticket_error_response(error.as_ref()),
                    }
                }
            },
        );
        routes.entry(path.into()).or_default().insert(method, route);
    }
    routes
}

fn ticket_principal(principal: &ServerPrincipal) -> TicketPrincipal<'_> {
    match principal {
        ServerPrincipal::Local => TicketPrincipal::Local,
        ServerPrincipal::Authenticated {
            owner_key,
            username,
            ..
        } => TicketPrincipal::Authenticated {
            key: owner_key,
            username,
        },
        ServerPrincipal::Executor { executor_id, .. } => TicketPrincipal::Executor { executor_id },
    }
}

fn query(url: &Url) -> Result<Opaque, Box<dyn Error>> {
    validate_ticket_input(|| ticket_query_params(url.query().unwrap_or("")))
}

async fn handle(
    tickets: &TicketRuntime,
    action: TicketRoute,
    mut request: HttpRequest,
    url: &Url,
    context: &HttpRouteContext,
) -> RouteResult {
    let principal = require_ticket_principal(context)?;
    let signal = request.body().cancellation().clone();
    if signal.is_cancelled() {
        return Err("The operation was aborted.".into());
    }
    let ok = StatusCode::OK;
    match action {
        TicketRoute::Bootstrap => {
            let query = query(url)?;
            validate_ticket_input(|| ticket_record(&query, &[]))?;
            let service = tickets.service()?;
            ticket_json(
                &service.bootstrap(
                    &derive_ticket_caller(ticket_principal(principal), None)?.authority,
                )?,
                ok,
            )
        }
        TicketRoute::List => ticket_json(&tickets.service()?.list(query(url)?.as_value())?, ok),
        TicketRoute::Counts => ticket_json(&tickets.service()?.counts(query(url)?.as_value())?, ok),
        TicketRoute::Detail => {
            let service = tickets.service()?;
            let query = query(url)?;
            ticket_json(
                &service.read(
                    &query,
                    &derive_ticket_caller(ticket_principal(principal), None)?.authority,
                )?,
                ok,
            )
        }
        TicketRoute::Comments => {
            let service = tickets.service()?;
            let query = query(url)?;
            ticket_json(
                &service.comments(
                    &query,
                    &derive_ticket_caller(ticket_principal(principal), None)?.authority,
                )?,
                ok,
            )
        }
        TicketRoute::History => {
            ticket_json(&tickets.service()?.history(query(url)?.as_value())?, ok)
        }
        TicketRoute::Facets => {
            let query = query(url)?;
            let raw = validate_ticket_input(|| ticket_record(&query, &["field", "prefix"]))?;
            let facet = match raw.get("field").and_then(Value::as_str) {
                Some("project") => Facet::Project,
                Some("label") => Facet::Label,
                _ => {
                    return Err(ticket_error(
                        ErrorCode::TICKET_VALIDATION_FAILED,
                        "Facet field must be project or label.",
                    ));
                }
            };
            let empty = Value::String(String::new());
            let prefix = validate_ticket_input(|| {
                ticket_string(
                    raw.get("prefix")
                        .filter(|value| !value.is_null())
                        .unwrap_or(&empty),
                    "prefix",
                )
            })?;
            ticket_json(&tickets.service()?.facets(facet, prefix)?, ok)
        }
        TicketRoute::Mutate => {
            let raw = read_ticket_body(&mut request).await?;
            let envelope = validate_ticket_input(|| parse_http_ticket_mutation_request(&raw))?;
            let caller = derive_ticket_caller(
                ticket_principal(principal),
                envelope.from_chat_id.as_deref(),
            )?;
            let status = if matches!(envelope.payload, TicketMutationPayload::Create { .. }) {
                StatusCode::CREATED
            } else {
                ok
            };
            ticket_json(
                &tickets.service()?.execute_http(envelope, caller, &signal)?,
                status,
            )
        }
    }
}
