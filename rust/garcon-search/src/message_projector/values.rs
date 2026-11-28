// Walks typed nested objects in the original's property order without
// serializing or traversing values beyond the extraction budget.

use garcon_contract::{
    chat_plan::{CursorPlanPhase, CursorPlanTodo},
    chat_types::{
        AskUserQuestionOption, AskUserQuestionPrompt, CodexSubagentDetails, CodexSubagentInputItem,
    },
    tool_schedule::ToolScheduleRequest,
};
use garcon_js::Number;

use super::{
    enum_text,
    extraction::{Compound, ExtractionBudget, javascript_keys},
};

pub(super) fn ask_question(
    budget: &mut ExtractionBudget,
    depth: usize,
    value: &AskUserQuestionPrompt,
) -> String {
    budget.compound(depth, |object| {
        object.text("id", &value.id);
        object.text("prompt", &value.prompt);
        object.field("options", |budget, depth| {
            budget.list(&value.options, depth, question_option)
        });
        object.optional_text("header", value.header.as_deref());
        // These keys are assigned even when the parser leaves a value undefined.
        object.boolean("allowMultiple", value.allow_multiple);
        object.boolean("allowFreeText", value.allow_free_text);
        object.boolean("allowNotes", value.allow_notes);
        object.boolean("isSecret", value.is_secret);
    })
}

fn question_option(
    budget: &mut ExtractionBudget,
    depth: usize,
    value: &AskUserQuestionOption,
) -> String {
    budget.compound(depth, |object| {
        object.text("id", &value.id);
        object.text("label", &value.label);
        object.optional_text("description", value.description.as_deref());
        object.optional_text("preview", value.preview.as_deref());
    })
}

pub(super) fn cursor_phase(
    budget: &mut ExtractionBudget,
    depth: usize,
    value: &CursorPlanPhase,
) -> String {
    budget.compound(depth, |object| {
        object.text("name", &value.name);
        object.field("todos", |budget, depth| {
            budget.list(&value.todos, depth, cursor_todo)
        });
    })
}

pub(super) fn cursor_todo(
    budget: &mut ExtractionBudget,
    depth: usize,
    value: &CursorPlanTodo,
) -> String {
    budget.compound(depth, |object| {
        object.text("content", &value.content);
        object.text("status", &enum_text(value.status));
        object.optional_text("id", value.id.as_deref());
    })
}

pub(super) fn schedule_request(
    budget: &mut ExtractionBudget,
    depth: usize,
    request: &ToolScheduleRequest,
) -> String {
    budget.compound(depth, |object| match request {
        ToolScheduleRequest::Wakeup(value) => {
            object.text("action", "wakeup");
            object.number("delaySeconds", value.delay_seconds.0);
            object.text("prompt", &value.prompt);
            object.optional_text("timerCondition", value.timer_condition.as_deref());
            optional_boolean(object, "daemon", value.daemon);
            optional_boolean(object, "exactTiming", value.exact_timing);
            object.optional_text("reason", value.reason.as_deref());
            optional_boolean(object, "noop", value.noop);
            object.optional_text("expression", value.expression.as_deref());
            optional_number(object, "maxIterations", value.max_iterations);
        }
        ToolScheduleRequest::Cron(value) => {
            object.text("action", "cron");
            object.text("expression", &value.expression);
            object.text("prompt", &value.prompt);
            optional_boolean(object, "recurring", value.recurring);
            optional_boolean(object, "durable", value.durable);
            optional_boolean(object, "daemon", value.daemon);
            optional_number(object, "maxIterations", value.max_iterations);
            optional_boolean(object, "exactTiming", value.exact_timing);
            optional_number(object, "delaySeconds", value.delay_seconds);
            object.optional_text("timerCondition", value.timer_condition.as_deref());
        }
        ToolScheduleRequest::List => object.text("action", "list"),
        ToolScheduleRequest::StopLoop => object.text("action", "stop-loop"),
        ToolScheduleRequest::Delete { job_id } => {
            object.text("action", "delete");
            object.text("jobId", job_id);
        }
    })
}

pub(super) fn subagent_details(
    budget: &mut ExtractionBudget,
    depth: usize,
    value: &CodexSubagentDetails,
) -> String {
    budget.compound(depth, |object| {
        object.optional_text("target", value.target.as_deref());
        object.optional_text("threadId", value.thread_id.as_deref());
        if let Some(targets) = &value.targets {
            object.field("targets", |budget, depth| {
                budget.optional_strings(Some(targets), depth)
            });
        }
        object.optional_text("message", value.message.as_deref());
        object.optional_text("taskName", value.task_name.as_deref());
        object.optional_text("agentType", value.agent_type.as_deref());
        object.optional_text("model", value.model.as_deref());
        object.optional_text("reasoningEffort", value.reasoning_effort.as_deref());
        object.optional_text("serviceTier", value.service_tier.as_deref());
        optional_boolean(object, "forkContext", value.fork_context);
        object.optional_text("forkTurns", value.fork_turns.as_deref());
        optional_number(object, "timeoutMs", value.timeout_ms);
        object.optional_text("pathPrefix", value.path_prefix.as_deref());
        optional_boolean(object, "interrupt", value.interrupt);
        if let Some(items) = &value.items {
            object.field("items", |budget, depth| {
                budget.list(items, depth, subagent_item)
            });
        }
        if let Some(states) = &value.agent_states {
            object.field("agentStates", |budget, depth| {
                budget.compound(depth, |object| {
                    for key in javascript_keys(states.keys()) {
                        if !object.can_add_field() {
                            break;
                        }
                        let state = &states[key];
                        object.field(key, |budget, depth| {
                            budget.compound(depth, |object| {
                                object.text("status", &enum_text(state.status));
                                object.optional_text("message", state.message.as_deref());
                            })
                        });
                    }
                })
            });
        }
        if let Some(source) = value.lifecycle_source {
            object.text("lifecycleSource", &enum_text(source));
        }
        object.optional_text("sourceFingerprint", value.source_fingerprint.as_deref());
    })
}

fn subagent_item(
    budget: &mut ExtractionBudget,
    depth: usize,
    value: &CodexSubagentInputItem,
) -> String {
    budget.compound(depth, |object| {
        object.optional_text("type", value.input_type.as_deref());
        object.optional_text("text", value.text.as_deref());
        object.optional_text("imageUrl", value.image_url.as_deref());
        object.optional_text("path", value.path.as_deref());
        object.optional_text("name", value.name.as_deref());
    })
}

fn optional_boolean(object: &mut Compound<'_>, key: &str, value: Option<bool>) {
    if value.is_some() {
        object.boolean(key, value);
    }
}

fn optional_number(object: &mut Compound<'_>, key: &str, value: Option<Number>) {
    if let Some(value) = value {
        object.number(key, value.0);
    }
}
