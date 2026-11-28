//! Ports `prompt.test.js`.

use garcon_agent_opencode::agents::opencode::prompt::{
    GARCON_OPERATION_PART_METADATA_KEY, build_prompt_body, parse_open_code_model,
};
use serde_json::{Value, json};

fn image(data: &str, name: Option<&str>, mime_type: &str) -> Value {
    json!({ "kind": "image", "data": data, "name": name, "mimeType": mime_type })
}

fn text_part(body: &Value, index: usize) -> &Value {
    &body["parts"][index]
}

#[test]
fn keeps_the_operation_identity_on_a_single_text_part_without_attachments() {
    let body = Value::Object(build_prompt_body(
        "hello",
        Some("deepseek/deepseek-v4-flash"),
        "prt_1",
        &[],
        None,
    ));

    assert_eq!(
        body["parts"],
        json!([{
            "id": "prt_1",
            "type": "text",
            "text": "hello",
            "metadata": { GARCON_OPERATION_PART_METADATA_KEY: "prt_1" },
        }])
    );
    assert_eq!(
        body["model"],
        json!({ "providerID": "deepseek", "modelID": "deepseek-v4-flash" })
    );
}

#[test]
fn appends_image_attachments_as_provider_owned_file_parts_with_data_urls() {
    let attachments = [
        image(
            "data:image/png;base64,aGVsbG8=",
            Some("screenshot.png"),
            "image/png",
        ),
        image("data:image/jpeg;base64,d29ybGQ=", None, "image/jpeg"),
    ];
    let body = Value::Object(build_prompt_body(
        "describe this",
        None,
        "prt_1",
        &attachments,
        None,
    ));

    assert_eq!(
        body["parts"],
        json!([
            {
                "id": "prt_1",
                "type": "text",
                "text": "describe this",
                "metadata": { GARCON_OPERATION_PART_METADATA_KEY: "prt_1" },
            },
            {
                "type": "file",
                "mime": "image/png",
                "url": "data:image/png;base64,aGVsbG8=",
                "filename": "screenshot.png",
            },
            {
                "type": "file",
                "mime": "image/jpeg",
                "url": "data:image/jpeg;base64,d29ybGQ=",
            },
        ])
    );
    assert!(body.as_object().expect("an object").get("model").is_none());
}

#[test]
fn drops_non_image_attachment_kinds() {
    let body = Value::Object(build_prompt_body(
        "hello",
        None,
        "prt_1",
        &[json!({
            "kind": "video",
            "data": "data:video/mp4;base64,ZGF0YQ==",
            "name": null,
            "mimeType": "video/mp4",
        })],
        None,
    ));

    assert_eq!(body["parts"].as_array().expect("an array").len(), 1);
    assert_eq!(text_part(&body, 0)["type"], json!("text"));
    assert_eq!(text_part(&body, 0)["text"], json!("hello"));
}

#[test]
fn carries_the_resolved_thinking_variant_next_to_the_model() {
    let body = Value::Object(build_prompt_body(
        "hello",
        Some("anthropic/claude-sonnet-4-6"),
        "prt_1",
        &[],
        Some("high"),
    ));
    assert_eq!(
        body["model"],
        json!({ "providerID": "anthropic", "modelID": "claude-sonnet-4-6" })
    );
    assert_eq!(body["variant"], json!("high"));
    // `variant` follows `model`, as the original appends it.
    let keys: Vec<&str> = body
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(keys, ["parts", "model", "variant"]);
}

#[test]
fn omits_the_variant_field_when_no_thinking_variant_resolved() {
    let body = Value::Object(build_prompt_body(
        "hello",
        Some("anthropic/claude-sonnet-4-6"),
        "prt_1",
        &[],
        None,
    ));
    assert!(
        body.as_object()
            .expect("an object")
            .get("variant")
            .is_none()
    );
}

#[test]
fn splits_a_model_at_its_first_separator() {
    let model = parse_open_code_model(Some("provider/model/with/slashes"));
    assert_eq!(
        model.map(|model| (model.provider_id, model.model_id)),
        Some(("provider".to_owned(), "model/with/slashes".to_owned()))
    );
    for model in ["", "/model", "provider/", "/", "noslash"] {
        assert_eq!(parse_open_code_model(Some(model)), None, "{model:?}");
    }
    assert_eq!(parse_open_code_model(None), None);
}
