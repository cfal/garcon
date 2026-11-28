//! Ports `questions.test.js`.

use std::sync::LazyLock;

use crate::support::event;
use garcon_agent_opencode::agents::opencode::questions::{
    OpenCodeQuestionDecision, extract_open_code_question_request, map_open_code_question_decision,
};
use garcon_contract::chat_command_contracts::{
    PermissionDecisionPayload, PermissionDecisionResponse,
};
use garcon_contract::chat_message_coercion::as_ask_user_questions;
use garcon_js::json::Opaque;
use serde_json::{Value, json};

static QUESTIONS: LazyLock<Value> = LazyLock::new(|| {
    json!([
        {
            "id": "question-1",
            "prompt": "Which mode?",
            "options": [
                { "id": "question-1-option-1", "label": "Fast" },
                { "id": "question-1-option-2", "label": "Careful" },
            ],
            "allowMultiple": false,
        },
        {
            "id": "question-2",
            "prompt": "Which checks?",
            "options": [
                { "id": "question-2-option-1", "label": "Unit tests" },
                { "id": "question-2-option-2", "label": "Integration tests" },
            ],
            "allowMultiple": true,
        },
    ])
});

fn decision(response: Option<Value>) -> PermissionDecisionPayload {
    PermissionDecisionPayload {
        allow: true,
        always_allow: None,
        response: response
            .map(|response| PermissionDecisionResponse::Provider(Opaque::from_value(response))),
    }
}

fn map(response: Option<Value>) -> Result<OpenCodeQuestionDecision, Box<dyn std::error::Error>> {
    map_open_code_question_decision(&as_ask_user_questions(&QUESTIONS), &decision(response))
}

#[test]
fn extracts_the_routed_provider_request_fields() {
    let request = extract_open_code_question_request(&event(&json!({
        "type": "question.asked",
        "properties": {
            "id": "provider-request",
            "sessionID": "session-a",
            "questions": [{ "question": "Which mode?", "header": "Mode", "options": [] }],
            "tool": { "callID": "call-question", "messageID": "assistant-a" },
        },
    })))
    .expect("a question request");

    assert_eq!(request.request_id, "provider-request");
    assert_eq!(request.tool_call_id, "call-question");
    assert_eq!(
        request.questions,
        json!([{ "question": "Which mode?", "header": "Mode", "options": [] }])
    );
}

#[test]
fn rejects_malformed_question_events() {
    for malformed in [
        json!({ "type": "message.updated", "properties": {} }),
        json!({ "type": "question.asked", "properties": { "questions": [], "tool": { "callID": "call" } } }),
        json!({ "type": "question.asked", "properties": { "id": "request", "questions": {}, "tool": { "callID": "call" } } }),
        json!({ "type": "question.asked", "properties": { "id": "request", "questions": [], "tool": {} } }),
    ] {
        assert!(
            extract_open_code_question_request(&event(&malformed)).is_none(),
            "{malformed}"
        );
    }
}

#[test]
fn maps_selected_option_identities_to_ordered_opencode_answer_labels() {
    let mapped = map(Some(json!({
        "type": "ask-user-question-response",
        "outcome": "answered",
        "answers": [
            { "questionId": "question-2", "selectedOptionIds": ["question-2-option-1", "question-2-option-2"] },
            { "questionId": "question-1", "selectedOptionIds": ["question-1-option-2"] },
        ],
    })))
    .expect("a decision");

    assert_eq!(
        mapped,
        OpenCodeQuestionDecision::Reply {
            answers: vec![
                vec!["Careful".to_owned()],
                vec!["Unit tests".to_owned(), "Integration tests".to_owned()],
            ],
        }
    );
}

#[test]
fn maps_denial_and_skip_to_rejection() {
    let denied = PermissionDecisionPayload {
        allow: false,
        always_allow: None,
        response: None,
    };
    assert_eq!(
        map_open_code_question_decision(&as_ask_user_questions(&QUESTIONS), &denied)
            .expect("a decision"),
        OpenCodeQuestionDecision::Reject
    );
    let skipped = map(Some(json!({
        "type": "ask-user-question-response",
        "outcome": "skipped",
        "reason": "User skipped question",
    })))
    .expect("a decision");
    assert_eq!(skipped, OpenCodeQuestionDecision::Reject);
}

#[test]
fn refuses_an_allow_decision_without_canonical_question_answers() {
    let error = map(None).expect_err("a decision without answers is refused");
    assert_eq!(
        error.to_string(),
        "OpenCode question decision is missing an answered response"
    );
}

#[test]
fn refuses_provider_answers_containing_an_unknown_identity() {
    let answers = |answers: Value| json!({ "type": "ask-user-question-response", "outcome": "answered", "answers": answers });
    for (answers, expected) in [
        (
            answers(json!([{ "questionId": "unknown-question", "selectedOptionIds": [] }])),
            "OpenCode question decision contains an unknown question ID",
        ),
        (
            answers(
                json!([{ "questionId": "question-1", "selectedOptionIds": ["unknown-option"] }]),
            ),
            "OpenCode question decision contains an unknown option ID",
        ),
    ] {
        let error = map(Some(answers)).expect_err("an unknown identity is refused");
        assert_eq!(error.to_string(), expected);
    }
}
