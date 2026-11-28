use bytes::Bytes;
use http::header::{CONTENT_TYPE, HeaderValue};
use http::{Response, StatusCode};
use serde::Serialize;

use super::http_route_types::RouteResponse;

pub fn json_response(
    status: StatusCode,
    body: &impl Serialize,
) -> Result<RouteResponse, serde_json::Error> {
    let mut response = Response::new(Some(Bytes::from(serde_json::to_vec(body)?)));
    *response.status_mut() = status;
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/json;charset=utf-8"),
    );
    Ok(response)
}
