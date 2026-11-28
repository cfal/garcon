//! Ports `common/chat-canvas.ts`.

use std::collections::HashSet;

use garcon_js::{Number, date_parse::date_parse, is_safe_integer, json::as_number, trim, utf16};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_id::{ChatId, InvalidChatIdError, parse_chat_id_input};

pub const CANVAS_MAX_NODES: usize = 1_000;
pub const CANVAS_MAX_CONNECTIONS: usize = 2_000;
pub const CANVAS_MAX_COUNT: usize = 100;
pub const CANVAS_TITLE_MAX_LENGTH: usize = 120;
pub const CANVAS_LABEL_MAX_LENGTH: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CanvasPosition {
    pub x: Number,
    pub y: Number,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CanvasBoxKind {
    Box,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanvasBox {
    pub id: String,
    pub position: CanvasPosition,
    #[serde(rename = "type")]
    kind: CanvasBoxKind,
    pub title: String,
}

impl CanvasBox {
    pub fn new(id: String, position: CanvasPosition, title: String) -> Self {
        Self {
            id,
            position,
            kind: CanvasBoxKind::Box,
            title,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CanvasChatKind {
    Chat,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasChat {
    pub id: String,
    pub position: CanvasPosition,
    #[serde(rename = "type")]
    kind: CanvasChatKind,
    pub chat_id: ChatId,
    pub box_id: Option<String>,
}

impl CanvasChat {
    pub fn new(
        id: String,
        position: CanvasPosition,
        chat_id: ChatId,
        box_id: Option<String>,
    ) -> Self {
        Self {
            id,
            position,
            kind: CanvasChatKind::Chat,
            chat_id,
            box_id,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CanvasNode {
    Box(CanvasBox),
    Chat(CanvasChat),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasSide {
    Top,
    Right,
    Bottom,
    Left,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasConnection {
    pub id: String,
    pub source: String,
    pub target: String,
    pub source_side: CanvasSide,
    pub target_side: CanvasSide,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CanvasContent {
    pub title: String,
    pub nodes: Vec<CanvasNode>,
    pub connections: Vec<CanvasConnection>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCanvas {
    pub version: u8,
    pub id: String,
    pub revision: u64,
    pub updated_at: String,
    pub content: CanvasContent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSummary {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasListResponse {
    pub canvases: Vec<CanvasSummary>,
    pub unavailable_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CreateCanvasRequest {
    pub id: String,
    pub content: CanvasContent,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCanvasRequest {
    pub id: String,
    pub content: CanvasContent,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCanvasRequest {
    pub id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DeleteCanvasResponse {
    pub success: bool,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CanvasValidationError {
    #[error("Invalid canvas title or element count")]
    TitleOrCount,
    #[error("Invalid or duplicate canvas node")]
    Node,
    #[error("Invalid canvas node content")]
    NodeContent,
    #[error("Canvas chat references an unknown box")]
    UnknownBox,
    #[error("Invalid canvas connection")]
    Connection,
    #[error("Invalid canvas document")]
    Document,
    #[error("Invalid canvas list")]
    List,
    #[error("Invalid canvas summary")]
    Summary,
    #[error("Invalid unavailable canvas ID")]
    UnavailableId,
    #[error(transparent)]
    InvalidChatId(#[from] InvalidChatIdError),
}

pub fn is_canvas_id(value: &Value) -> bool {
    canvas_id(value).is_some()
}

fn canvas_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| {
        !text.is_empty()
            && text.len() <= 80
            && text
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    })
}

pub fn is_canvas_revision(value: &Value) -> Option<u64> {
    as_number(value)
        .filter(|&n| is_safe_integer(n) && n >= 1.0)
        .map(|n| n as u64)
}

fn text(value: &Value, max: usize, required: bool) -> Option<&str> {
    value
        .as_str()
        .filter(|text| utf16::len(text) <= max && (!required || !trim(text).is_empty()))
}

fn position(value: &Value) -> Option<CanvasPosition> {
    let coordinate = |key: &str| {
        as_number(&value[key])
            .filter(|n| n.is_finite() && n.abs() <= 10_000_000.0)
            .map(Number)
    };
    Some(CanvasPosition {
        x: coordinate("x")?,
        y: coordinate("y")?,
    })
}

pub fn is_canvas_side(value: &Value) -> Option<CanvasSide> {
    match value.as_str()? {
        "top" => Some(CanvasSide::Top),
        "right" => Some(CanvasSide::Right),
        "bottom" => Some(CanvasSide::Bottom),
        "left" => Some(CanvasSide::Left),
        _ => None,
    }
}

pub fn parse_canvas_content(value: &Value) -> Result<CanvasContent, CanvasValidationError> {
    use CanvasValidationError as Error;
    let title = text(&value["title"], CANVAS_TITLE_MAX_LENGTH, true).ok_or(Error::TitleOrCount)?;
    let node_values = value["nodes"]
        .as_array()
        .filter(|nodes| nodes.len() <= CANVAS_MAX_NODES)
        .ok_or(Error::TitleOrCount)?;
    let edge_values = value["connections"]
        .as_array()
        .filter(|edges| edges.len() <= CANVAS_MAX_CONNECTIONS)
        .ok_or(Error::TitleOrCount)?;
    let mut node_ids = HashSet::with_capacity(node_values.len());
    let mut nodes = Vec::with_capacity(node_values.len());
    for node in node_values {
        let id = canvas_id(&node["id"])
            .filter(|id| !node_ids.contains(id))
            .ok_or(Error::Node)?;
        let position = position(&node["position"]).ok_or(Error::Node)?;
        node_ids.insert(id);
        match node["type"].as_str() {
            Some("box") => {
                let title = text(&node["title"], CANVAS_TITLE_MAX_LENGTH, true)
                    .ok_or(Error::NodeContent)?;
                nodes.push(CanvasNode::Box(CanvasBox::new(
                    id.to_owned(),
                    position,
                    title.to_owned(),
                )));
            }
            Some("chat") => {
                let box_id = match node.get("boxId") {
                    Some(Value::Null) => None,
                    Some(value) => Some(canvas_id(value).ok_or(Error::NodeContent)?.to_owned()),
                    None => return Err(Error::NodeContent),
                };
                let chat_id = parse_chat_id_input(node.get("chatId"))?;
                nodes.push(CanvasNode::Chat(CanvasChat::new(
                    id.to_owned(),
                    position,
                    chat_id,
                    box_id,
                )));
            }
            _ => return Err(Error::NodeContent),
        }
    }
    let boxes: HashSet<_> = nodes
        .iter()
        .filter_map(|node| match node {
            CanvasNode::Box(node) => Some(node.id.as_str()),
            _ => None,
        })
        .collect();
    if nodes.iter().any(|node| matches!(node, CanvasNode::Chat(chat) if chat.box_id.as_deref().is_some_and(|box_id| !boxes.contains(box_id)))) {
        return Err(Error::UnknownBox);
    }
    let mut edge_ids = HashSet::with_capacity(edge_values.len());
    let mut connections = Vec::with_capacity(edge_values.len());
    for edge in edge_values {
        let id = canvas_id(&edge["id"])
            .filter(|id| !edge_ids.contains(id) && !node_ids.contains(id))
            .ok_or(Error::Connection)?;
        let source = edge["source"]
            .as_str()
            .filter(|source| node_ids.contains(source))
            .ok_or(Error::Connection)?;
        let target = edge["target"]
            .as_str()
            .filter(|target| *target != source && node_ids.contains(target))
            .ok_or(Error::Connection)?;
        let source_side = is_canvas_side(&edge["sourceSide"]).ok_or(Error::Connection)?;
        let target_side = is_canvas_side(&edge["targetSide"]).ok_or(Error::Connection)?;
        let label =
            text(&edge["label"], CANVAS_LABEL_MAX_LENGTH, false).ok_or(Error::Connection)?;
        edge_ids.insert(id);
        connections.push(CanvasConnection {
            id: id.to_owned(),
            source: source.to_owned(),
            target: target.to_owned(),
            source_side,
            target_side,
            label: label.to_owned(),
        });
    }
    Ok(CanvasContent {
        title: title.to_owned(),
        nodes,
        connections,
    })
}

fn canvas_date(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| date_parse(text).is_some())
        .map(str::to_owned)
}

pub fn parse_chat_canvas(value: &Value) -> Result<ChatCanvas, CanvasValidationError> {
    use CanvasValidationError::Document;
    if as_number(&value["version"]) != Some(1.0) {
        return Err(Document);
    }
    let id = canvas_id(&value["id"]).ok_or(Document)?.to_owned();
    let revision = is_canvas_revision(&value["revision"]).ok_or(Document)?;
    let updated_at = canvas_date(&value["updatedAt"]).ok_or(Document)?;
    let content = parse_canvas_content(&value["content"])?;
    Ok(ChatCanvas {
        version: 1,
        id,
        revision,
        updated_at,
        content,
    })
}

pub fn canvas_summary(canvas: &ChatCanvas) -> CanvasSummary {
    CanvasSummary {
        id: canvas.id.clone(),
        title: canvas.content.title.clone(),
        revision: canvas.revision,
        updated_at: canvas.updated_at.clone(),
    }
}

pub fn parse_canvas_list(value: &Value) -> Result<CanvasListResponse, CanvasValidationError> {
    use CanvasValidationError as Error;
    let canvas_values = value["canvases"].as_array().ok_or(Error::List)?;
    let unavailable = value["unavailableIds"].as_array().ok_or(Error::List)?;
    if canvas_values.len() + unavailable.len() > CANVAS_MAX_COUNT {
        return Err(Error::List);
    }
    let mut ids = HashSet::with_capacity(canvas_values.len() + unavailable.len());
    let mut canvases = Vec::with_capacity(canvas_values.len());
    for canvas in canvas_values {
        let id = canvas_id(&canvas["id"])
            .filter(|id| !ids.contains(id))
            .ok_or(Error::Summary)?;
        let title = text(&canvas["title"], CANVAS_TITLE_MAX_LENGTH, true)
            .ok_or(Error::Summary)?
            .to_owned();
        let revision = is_canvas_revision(&canvas["revision"]).ok_or(Error::Summary)?;
        let updated_at = canvas_date(&canvas["updatedAt"]).ok_or(Error::Summary)?;
        ids.insert(id);
        canvases.push(CanvasSummary {
            id: id.to_owned(),
            title,
            revision,
            updated_at,
        });
    }
    let unavailable_ids = unavailable
        .iter()
        .map(|value| {
            let id = canvas_id(value)
                .filter(|id| ids.insert(*id))
                .ok_or(Error::UnavailableId)?;
            Ok(id.to_owned())
        })
        .collect::<Result<Vec<_>, Error>>()?;
    Ok(CanvasListResponse {
        canvases,
        unavailable_ids,
    })
}
