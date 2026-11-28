//! Provider management reads are independent of executor readiness.

use std::{error::Error, rc::Rc};

use garcon_base::{
    domain_error::DomainError,
    errors::ErrorInput,
    http_error::json_error_from_unknown,
    json_file_store::{CorruptStateFileError, ReadJsonStateError},
};
use garcon_contract::error_codes::ErrorCode;
use garcon_stores::api_providers::{renamed_write, service::ApiProviderService};
use http::{Method, StatusCode};

use crate::{
    compose_routes::RouteMap,
    http_route_types::{Route, RouteMetadata, RouteResult},
    json_route::json_response,
};

pub fn create_api_provider_routes(service: Rc<ApiProviderService>) -> RouteMap<Route> {
    let management = Route::new(RouteMetadata::default(), move |_, _, _| {
        let service = service.clone();
        async move {
            match service.management() {
                Ok(snapshot) => Ok(json_response(StatusCode::OK, &snapshot)?),
                Err(error) => provider_error(error.as_ref()),
            }
        }
    });
    RouteMap::from([
        (
            "/api/v1/api-providers".into(),
            [(Method::GET, management.clone())].into(),
        ),
        (
            "/api/v1/api-provider-assignments".into(),
            [(Method::GET, management)].into(),
        ),
    ])
}

fn provider_error(error: &(dyn Error + 'static)) -> RouteResult {
    if renamed_write(error) {
        let unavailable = DomainError::new(
            ErrorCode::API_PROVIDER_STORAGE_UNAVAILABLE,
            "Provider save durability is unknown. Reload after checking controller configuration.",
            503,
            false,
        );
        return Ok(
            json_error_from_unknown(ErrorInput::Error(&unavailable), None, None, None)?.map(Some),
        );
    }
    let corrupt = error.is::<CorruptStateFileError>()
        || matches!(
            error.downcast_ref::<ReadJsonStateError>(),
            Some(ReadJsonStateError::Corrupt(_))
        );
    Ok(json_error_from_unknown(
        ErrorInput::Error(error),
        (!corrupt).then_some(400.0),
        None,
        None,
    )?
    .map(Some))
}
