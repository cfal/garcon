//! Noncacheable and credential-free runtime proof responses.

use bytes::Bytes;
use garcon_contract::server_runtime::{ServerRuntimeProbe, is_runtime_probe_challenge_text};
use http::{HeaderValue, Response, StatusCode, header};
use serde_json::json;
use url::Url;

use crate::http_error::json_response;
use crate::server_runtime::{ServerRuntimeState, create_server_runtime_proof};

pub fn runtime_proof_response(
    state: &ServerRuntimeState,
    url: &Url,
) -> Result<Response<Bytes>, serde_json::Error> {
    let challenge = url
        .query_pairs()
        .find_map(|(key, value)| (key == "challenge").then_some(value));
    let mut response = if let Some(challenge) =
        challenge.filter(|challenge| is_runtime_probe_challenge_text(challenge))
    {
        // INFALLIBLE: the challenge was accepted by the same predicate above.
        let proof =
            create_server_runtime_proof(state, &challenge).expect("checked runtime challenge");
        json_response(
            StatusCode::OK,
            &ServerRuntimeProbe {
                schema_version: state.identity.schema_version,
                instance_id: state.identity.instance_id.clone(),
                proof,
            },
        )?
    } else {
        json_response(
            StatusCode::BAD_REQUEST,
            &json!({ "error": "challenge must be 32-byte base64url data" }),
        )?
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server_runtime::runtime_state_with_identity;
    use garcon_js::{ManualClock, json::from_slice};
    use serde_json::Value;
    use uuid::Uuid;

    #[test]
    fn sends_no_store_for_both_a_proof_and_an_invalid_challenge() {
        let state =
            runtime_state_with_identity("/fixture", &ManualClock::new(0), Uuid::nil(), [0; 32])
                .unwrap();
        let challenge = "a".repeat(43);
        let url = Url::parse(&format!(
            "http://localhost/probe?challenge={challenge}&challenge=ignored"
        ))
        .unwrap();
        let response = runtime_proof_response(&state, &url).unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let result = from_slice::<Value>(response.body()).unwrap();
        assert!(result.get("localCapability").is_none());
        assert_eq!(
            result["proof"],
            create_server_runtime_proof(&state, &challenge).unwrap()
        );
        let url = Url::parse(&format!(
            "http://localhost/probe?challenge=short&challenge={challenge}"
        ))
        .unwrap();
        let response = runtime_proof_response(&state, &url).unwrap();
        assert_eq!(response.status(), 400);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            from_slice::<Value>(response.body()).unwrap(),
            json!({"error":"challenge must be 32-byte base64url data"})
        );
    }
}
