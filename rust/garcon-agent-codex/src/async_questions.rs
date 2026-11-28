use garcon_contract::async_user_questions::{AsyncQuestionSet, parse_async_question_set};
use garcon_js::json::stringify;
use serde_json::{Value, json};

pub fn codex_async_questions(
    id: &str,
    delivery: &Value,
    value: &Value,
) -> Option<AsyncQuestionSet> {
    if delivery.as_str() != Some("async") {
        return None;
    }
    let questions = value
        .as_array()
        .filter(|questions| questions.len() <= 100)?;
    let questions = questions
        .iter()
        .enumerate()
        .map(|(index, question)| {
            let question = question.as_object()?;
            let options = match question.get("options") {
                None | Some(Value::Null) => &[][..],
                Some(options) => options
                    .as_array()
                    .filter(|options| !options.is_empty() && options.len() <= 100)?,
            };
            let options = options
                .iter()
                .enumerate()
                .map(|(index, label)| json!({"id":format!("option-{index}"),"label":label}))
                .collect::<Vec<_>>();
            Some(json!({
                "id":stringify(&json!(["request_user_input_async",id,index])),
                "prompt":question.get("title"),"options":options,"allowFreeText":true,
            }))
        })
        .collect::<Option<Vec<_>>>()?;
    parse_async_question_set(&json!({"id":id,"questions":questions}))
}
