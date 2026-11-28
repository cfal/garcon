use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Pending,
    InProgress,
    Completed,
    Skipped,
    Failed,
}

impl From<TodoStatus> for PlanStepStatus {
    fn from(status: TodoStatus) -> Self {
        match status {
            TodoStatus::Pending => Self::Pending,
            TodoStatus::InProgress => Self::InProgress,
            TodoStatus::Completed => Self::Completed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanStep {
    pub content: String,
    pub status: PlanStepStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CursorPlanTodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorPlanTodo {
    pub content: String,
    pub status: CursorPlanTodoStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CursorPlanPhase {
    pub name: String,
    pub todos: Vec<CursorPlanTodo>,
}

fn todo_status(object: &Map<String, Value>) -> TodoStatus {
    let status = object.get("status").and_then(Value::as_str);
    if object.get("completed").and_then(Value::as_bool) == Some(true)
        || matches!(status, Some("completed" | "done"))
    {
        return TodoStatus::Completed;
    }
    if matches!(status, Some("in_progress" | "in-progress")) {
        return TodoStatus::InProgress;
    }
    TodoStatus::Pending
}

fn checklist_items<T>(
    raw: &Value,
    item: impl Fn(&Map<String, Value>, String) -> T,
) -> Option<Vec<T>> {
    let items: Vec<T> = raw
        .as_array()?
        .iter()
        .filter_map(|value| {
            let object = value.as_object()?;
            let content = ["content", "text", "step"]
                .into_iter()
                .find_map(|key| object.get(key).filter(|value| !value.is_null()))?
                .as_str()?;
            Some(item(object, content.into()))
        })
        .collect();
    (!items.is_empty()).then_some(items)
}

pub fn coerce_todo_items(raw: &Value) -> Option<Vec<TodoItem>> {
    checklist_items(raw, |object, content| TodoItem {
        content,
        status: todo_status(object),
    })
}

pub fn coerce_plan_steps(raw: &Value) -> Option<Vec<PlanStep>> {
    if raw.as_array().is_some_and(Vec::is_empty) {
        return Some(Vec::new());
    }
    checklist_items(raw, |object, content| {
        let status = match object.get("status").and_then(Value::as_str) {
            Some("skipped") => PlanStepStatus::Skipped,
            Some("failed") => PlanStepStatus::Failed,
            _ => todo_status(object).into(),
        };
        PlanStep { content, status }
    })
}

pub fn as_cursor_plan_todos(value: &Value) -> Option<Vec<CursorPlanTodo>> {
    let values = value.as_array()?;
    let todos: Vec<_> = values
        .iter()
        .filter_map(|value| {
            let raw = value.as_object()?;
            let content = raw.get("content")?.as_str()?.into();
            let status = match raw.get("status").and_then(Value::as_str) {
                Some("completed") => CursorPlanTodoStatus::Completed,
                Some("in_progress") => CursorPlanTodoStatus::InProgress,
                Some("cancelled") => CursorPlanTodoStatus::Cancelled,
                _ => CursorPlanTodoStatus::Pending,
            };
            let id = raw.get("id").and_then(Value::as_str).map(str::to_owned);
            Some(CursorPlanTodo {
                content,
                status,
                id,
            })
        })
        .collect();
    (!todos.is_empty() || values.is_empty()).then_some(todos)
}

pub fn as_cursor_plan_phases(value: &Value) -> Option<Vec<CursorPlanPhase>> {
    let values = value.as_array()?;
    let phases: Vec<_> = values
        .iter()
        .filter_map(|value| {
            let raw = value.as_object()?;
            let name = raw.get("name")?.as_str()?.into();
            let todos = raw
                .get("todos")
                .and_then(as_cursor_plan_todos)
                .unwrap_or_default();
            Some(CursorPlanPhase { name, todos })
        })
        .collect();
    (!phases.is_empty() || values.is_empty()).then_some(phases)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checklist_uses_nullish_aliases_and_distinguishes_plan_statuses() {
        let value = json!([
            {"content": null, "text": "available", "status": "in-progress"},
            {"content": false, "step": "not used"},
            {"step": "kept", "status": "skipped", "completed": true},
        ]);
        assert_eq!(
            json!(coerce_todo_items(&value)),
            json!([
                {"content": "available", "status": "in_progress"},
                {"content": "kept", "status": "completed"},
            ])
        );
        assert_eq!(
            json!(coerce_plan_steps(&value)),
            json!([
                {"content": "available", "status": "in_progress"},
                {"content": "kept", "status": "skipped"},
            ])
        );
        assert!(coerce_todo_items(&json!([])).is_none());
        assert_eq!(coerce_plan_steps(&json!([])), Some(vec![]));
    }

    #[test]
    fn cursor_plans_keep_empty_phases_and_filter_non_cursor_todos() {
        let value = json!([
            {"name": "empty"},
            {"name": "phase", "todos": [
                {"content": "", "status": "cancelled", "id": "id"},
                {"content": "next", "status": "in-progress", "id": 42},
                {"text": "not a Cursor todo"},
            ]},
            {"name": false},
        ]);
        assert_eq!(
            json!(as_cursor_plan_phases(&value)),
            json!([
                {"name": "empty", "todos": []},
                {"name": "phase", "todos": [
                    {"content": "", "status": "cancelled", "id": "id"},
                    {"content": "next", "status": "pending"},
                ]},
            ])
        );
        assert_eq!(as_cursor_plan_todos(&json!([])), Some(vec![]));
        assert!(as_cursor_plan_todos(&json!([null, false, {}])).is_none());
    }
}
