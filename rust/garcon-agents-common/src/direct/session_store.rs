//! Ports `server-agents/common/src/direct/session-store.ts`.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io;
use std::rc::Rc;
use std::task::Poll;

use futures::future::LocalBoxFuture;
use garcon_base::KeyedLock;
use garcon_base::errors::NamedError;
use garcon_base::event_loop::EventLoopSteps;
use garcon_base::file_stat::{FileIdentity, stat_handle};
use garcon_base::json_file_store::sync_directory;
use garcon_contract::agent_execution::{AgentAttachment, AgentAttachmentKind};
use garcon_interface::host::AgentScopedStorage;
use garcon_interface::resources::ExecutorResult;
use garcon_interface::transcript::AgentNativeSessionRef;
use garcon_js::clock::{Clock, SystemClock};
use garcon_js::path::native;
use garcon_js::{date_parse::date_parse, json, to_iso_string, trim};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use tokio::fs::{self, File, OpenOptions};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::sync::OnceCell;
use uuid::Uuid;

const DIRECT_SESSION_NAMESPACE: &str = "direct-sessions-v1";
const DIRECT_SESSION_SCHEMA_VERSION: u64 = 1;
const DIRECT_SESSION_HEADER_MAX_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "session", rename_all = "camelCase")]
pub struct DirectSessionHeaderV1 {
    pub schema_version: u64,
    pub owner_id: String,
    pub session_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "user", rename_all = "camelCase")]
pub struct DirectUserRecordV1 {
    pub at: String,
    pub run_id: String,
    pub content: String,
    pub attachments: Vec<AgentAttachment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename = "openai-response", rename_all = "camelCase")]
pub struct DirectResponsesCheckpointV1 {
    pub response_id: String,
    pub endpoint_id: String,
    pub endpoint_fingerprint: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename = "assistant", rename_all = "camelCase")]
pub struct DirectAssistantRecordV1 {
    pub at: String,
    pub run_id: String,
    pub content: String,
    pub checkpoint: Option<DirectResponsesCheckpointV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum DirectSessionRecordV1 {
    User(DirectUserRecordV1),
    Assistant(DirectAssistantRecordV1),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectSessionSnapshot {
    pub header: DirectSessionHeaderV1,
    pub records: Vec<DirectSessionRecordV1>,
    pub path: String,
}

#[derive(Default)]
struct DirectSessionRuns {
    user_run_ids: HashSet<String>,
    assistant_run_ids: HashSet<String>,
}

struct ParsedSessionFile {
    header: DirectSessionHeaderV1,
    records: Vec<DirectSessionRecordV1>,
    append_offset: u64,
    separator: bool,
    ignored_tail: bool,
    runs: DirectSessionRuns,
}

pub type DirectSessionNow = dyn Fn() -> ExecutorResult<String>;
pub type DirectSessionReadFile =
    dyn for<'a> Fn(&'a mut File) -> LocalBoxFuture<'a, ExecutorResult<Vec<u8>>>;
pub type DirectSessionSyncDirectory =
    dyn for<'a> Fn(&'a str) -> LocalBoxFuture<'a, ExecutorResult<()>>;

pub struct DirectSessionStoreOptions {
    pub agent_id: String,
    pub storage: Rc<dyn AgentScopedStorage>,
    pub now: Option<Rc<DirectSessionNow>>,
    pub read_file: Option<Rc<DirectSessionReadFile>>,
    pub sync_directory: Option<Rc<DirectSessionSyncDirectory>>,
}

pub struct DirectUserInput {
    pub session_id: String,
    pub run_id: String,
    pub content: String,
    pub attachments: Vec<AgentAttachment>,
}

pub struct DirectAssistantInput {
    pub session_id: String,
    pub run_id: String,
    pub content: String,
    pub checkpoint: Option<DirectResponsesCheckpointV1>,
}

struct AppendState {
    identity: FileIdentity,
    offset: u64,
    ignored_tail: bool,
    separator: bool,
    runs: DirectSessionRuns,
}

struct Store {
    options: DirectSessionStoreOptions,
    operations: KeyedLock,
    append_states: RefCell<HashMap<String, AppendState>>,
    directory: OnceCell<String>,
}

#[derive(Clone)]
pub struct DirectSessionStore(Rc<Store>);

impl DirectSessionStore {
    pub fn new(options: DirectSessionStoreOptions) -> Self {
        Self(Rc::new(Store {
            options,
            operations: KeyedLock::new(),
            append_states: RefCell::default(),
            directory: OnceCell::new(),
        }))
    }

    pub fn create_session_id(&self) -> String {
        Uuid::new_v4().to_string()
    }

    pub fn native_reference(&self, session_id: &str) -> ExecutorResult<AgentNativeSessionRef> {
        require_session_id(Some(session_id))?;
        Ok(AgentNativeSessionRef {
            owner_id: self.0.options.agent_id.clone(),
            schema_version: DIRECT_SESSION_SCHEMA_VERSION,
            value: serde_json::json!({"sessionId": session_id}).into(),
        })
    }

    pub fn session_id_from_reference<'a>(
        &self,
        reference: Option<&'a AgentNativeSessionRef>,
        expected_session_id: Option<&str>,
    ) -> ExecutorResult<&'a str> {
        let reference = reference
            .filter(|reference| {
                reference.owner_id == self.0.options.agent_id
                    && reference.schema_version == DIRECT_SESSION_SCHEMA_VERSION
                    && has_exact_keys(&reference.value, &["sessionId"])
            })
            .ok_or_else(|| type_error("Direct native session reference is invalid"))?;
        let id = require_session_id(reference.value["sessionId"].as_str())?;
        if let Some(expected) = expected_session_id {
            require_session_id(Some(expected))?;
            if id != expected {
                return Err(type_error(
                    "Direct native session reference does not match the selected session",
                ));
            }
        }
        Ok(id)
    }

    pub async fn create(&self, input: DirectUserInput) -> ExecutorResult<DirectSessionSnapshot> {
        let id = input.session_id.clone();
        self.serialized(&id, move |store, id| async move {
            let directory = store.directory().await?;
            let path = session_file_path(directory, &id);
            let created_at = store.now()?;
            require_timestamp_str(non_empty_string(&created_at, "createdAt")?, "createdAt")?;
            let header = DirectSessionHeaderV1 {
                schema_version: DIRECT_SESSION_SCHEMA_VERSION,
                owner_id: non_empty_string(&store.0.options.agent_id, "ownerId")?.to_owned(),
                session_id: id.clone(),
                created_at: created_at.clone(),
            };
            let record = DirectSessionRecordV1::User(build_user_record(created_at, input)?);
            let mut payload = serde_json::to_vec(&header)?;
            payload.push(b'\n');
            serde_json::to_writer(&mut payload, &record)?;
            payload.push(b'\n');
            let mut open = open_options_without_symlink();
            open.write(true).create_new(true);
            #[cfg(unix)]
            open.mode(0o600);
            let mut file = open.open(&path).await?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(std::fs::Permissions::from_mode(0o600))
                    .await?;
            }
            file.write_all(&payload).await?;
            file.flush().await?;
            file.sync_all().await?;
            let identity = stat_handle(&file).await?.identity;
            drop(file);
            store.sync_directory(directory).await?;
            let mut runs = DirectSessionRuns::default();
            runs.accept(&record);
            store.0.append_states.borrow_mut().insert(
                id,
                AppendState {
                    identity,
                    offset: payload.len() as u64,
                    ignored_tail: false,
                    separator: false,
                    runs,
                },
            );
            Ok(DirectSessionSnapshot {
                header,
                records: vec![record],
                path,
            })
        })
        .await
    }

    pub async fn load(&self, session_id: &str) -> ExecutorResult<DirectSessionSnapshot> {
        self.serialized(session_id, |store, id| async move {
            let path = session_file_path(store.directory().await?, &id);
            let mut file = open_regular_file(&path, false).await?;
            let parsed = store.parse_file(&mut file, &id).await?;
            let identity = stat_handle(&file).await?.identity;
            let ParsedSessionFile {
                header,
                records,
                append_offset,
                separator,
                ignored_tail,
                runs,
            } = parsed;
            store.0.append_states.borrow_mut().insert(
                id,
                AppendState {
                    identity,
                    offset: append_offset,
                    ignored_tail,
                    separator,
                    runs,
                },
            );
            Ok(DirectSessionSnapshot {
                header,
                records,
                path,
            })
        })
        .await
    }

    pub async fn inspect(&self, session_id: &str) -> ExecutorResult<String> {
        self.serialized(session_id, |store, id| async move {
            let path = session_file_path(store.directory().await?, &id);
            let mut file = open_regular_file(&path, false).await?;
            let mut buffer = vec![0u8; DIRECT_SESSION_HEADER_MAX_BYTES + 1];
            let length = file.read(&mut buffer).await?;
            let Some(newline) = buffer[..length].iter().position(|byte| *byte == b'\n') else {
                return Err(type_error("Direct session header exceeds the maximum size"));
            };
            validate_session_header(&buffer[..newline], &store.0.options.agent_id, &id)?;
            Ok(path)
        })
        .await
    }

    pub async fn append_user(&self, input: DirectUserInput) -> ExecutorResult<DirectUserRecordV1> {
        let at = self.now()?;
        require_timestamp_str(non_empty_string(&at, "at")?, "at")?;
        let id = input.session_id.clone();
        let record = build_user_record(at, input)?;
        self.append(&id, DirectSessionRecordV1::User(record.clone()))
            .await?;
        Ok(record)
    }

    pub async fn append_assistant(
        &self,
        input: DirectAssistantInput,
    ) -> ExecutorResult<DirectAssistantRecordV1> {
        let at = self.now()?;
        require_timestamp_str(non_empty_string(&at, "at")?, "at")?;
        if trim(&input.content).is_empty() {
            return Err(type_error("Direct assistant record content is empty"));
        }
        non_empty_string(&input.run_id, "runId")?;
        if let Some(checkpoint) = &input.checkpoint {
            validate_checkpoint_fields(checkpoint)?;
        }
        let record = DirectAssistantRecordV1 {
            at,
            run_id: input.run_id,
            content: input.content,
            checkpoint: input.checkpoint,
        };
        self.append(
            &input.session_id,
            DirectSessionRecordV1::Assistant(record.clone()),
        )
        .await?;
        Ok(record)
    }

    pub async fn delete(&self, session_id: &str) -> ExecutorResult<()> {
        self.serialized(session_id, |store, id| async move {
            let directory = store.directory().await?;
            let path = session_file_path(directory, &id);
            match fs::remove_file(path).await {
                Ok(()) => {
                    store.0.append_states.borrow_mut().remove(&id);
                    store.sync_directory(directory).await
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    store.0.append_states.borrow_mut().remove(&id);
                    Ok(())
                }
                Err(error) => Err(error.into()),
            }
        })
        .await
    }

    async fn append(&self, id: &str, record: DirectSessionRecordV1) -> ExecutorResult<()> {
        self.serialized(id, move |store, id| async move {
            let path = session_file_path(store.directory().await?, &id);
            let mut file = open_regular_file(&path, true).await?;
            let observed_identity = stat_handle(&file).await?.identity;
            if store
                .0
                .append_states
                .borrow()
                .get(&id)
                .is_none_or(|state| state.identity != observed_identity)
            {
                let parsed = store.parse_file(&mut file, &id).await?;
                let identity = stat_handle(&file).await?.identity;
                store.0.append_states.borrow_mut().insert(
                    id.clone(),
                    AppendState {
                        identity,
                        offset: parsed.append_offset,
                        ignored_tail: parsed.ignored_tail,
                        separator: parsed.separator,
                        runs: parsed.runs,
                    },
                );
            }
            let (offset, ignored_tail, separator) = {
                let states = store.0.append_states.borrow();
                // INFALLIBLE: this lock owns the session, and a cache miss was populated above.
                let state = states
                    .get(&id)
                    .expect("append state exists under the session lock");
                state.runs.validate(&record)?;
                (state.offset, state.ignored_tail, state.separator)
            };
            if ignored_tail {
                file.set_len(offset).await?;
                file.sync_all().await?;
            }
            let mut encoded = Vec::new();
            if separator {
                encoded.push(b'\n');
            }
            serde_json::to_writer(&mut encoded, &record)?;
            encoded.push(b'\n');
            write_all(&mut file, &encoded, offset).await?;
            file.flush().await?;
            file.sync_all().await?;
            let identity = stat_handle(&file).await?.identity;
            let mut states = store.0.append_states.borrow_mut();
            // INFALLIBLE: the same session lock was held across the write and stat.
            let state = states
                .get_mut(&id)
                .expect("append state exists under the session lock");
            state.identity = identity;
            state.runs.accept(&record);
            state.offset = offset + encoded.len() as u64;
            state.ignored_tail = false;
            state.separator = false;
            Ok(())
        })
        .await
    }

    fn now(&self) -> ExecutorResult<String> {
        if let Some(now) = &self.0.options.now {
            return now();
        }
        Ok(to_iso_string(SystemClock.now_ms())?)
    }

    async fn directory(&self) -> ExecutorResult<&str> {
        Ok(self
            .0
            .directory
            .get_or_try_init(|| self.0.options.storage.directory(DIRECT_SESSION_NAMESPACE))
            .await?)
    }

    async fn sync_directory(&self, directory: &str) -> ExecutorResult<()> {
        if let Some(sync) = &self.0.options.sync_directory {
            return sync(directory).await;
        }
        Ok(sync_directory(directory).await?)
    }

    async fn parse_file(&self, file: &mut File, id: &str) -> ExecutorResult<ParsedSessionFile> {
        let raw = if let Some(read) = &self.0.options.read_file {
            read(file).await?
        } else {
            let mut data = Vec::new();
            file.read_to_end(&mut data).await?;
            data
        };
        parse_session_file(&raw, &self.0.options.agent_id, id).await
    }

    async fn serialized<T: 'static, F, Fut>(&self, session_id: &str, work: F) -> ExecutorResult<T>
    where
        F: FnOnce(Self, String) -> Fut + 'static,
        Fut: Future<Output = ExecutorResult<T>> + 'static,
    {
        let id = require_session_id(Some(session_id))?.to_owned();
        let store = self.clone();
        let mut task = Box::pin(async move {
            store
                .0
                .operations
                .run_exclusive(&id, || work(store.clone(), id.clone()), None)
                .await?
        });
        // The operation retains its place and lock even if the waiting future is dropped.
        match futures::poll!(&mut task) {
            Poll::Ready(result) => result,
            Poll::Pending => tokio::task::spawn_local(task).await?,
        }
    }
}

fn session_file_path(directory: &str, id: &str) -> String {
    native::join(&[directory, &format!("{id}.jsonl")])
}

fn build_user_record(at: String, input: DirectUserInput) -> ExecutorResult<DirectUserRecordV1> {
    for attachment in &input.attachments {
        non_empty_string(&attachment.data, "attachment data")?;
        non_empty_string(&attachment.mime_type, "attachment MIME type")?;
    }
    if input.content.is_empty() && input.attachments.is_empty() {
        return Err(type_error(
            "Direct user record requires content or attachments",
        ));
    }
    require_timestamp_str(&at, "at")?;
    non_empty_string(&input.run_id, "runId")?;
    Ok(DirectUserRecordV1 {
        at,
        run_id: input.run_id,
        content: input.content,
        attachments: input.attachments,
    })
}

fn validate_checkpoint_fields(checkpoint: &DirectResponsesCheckpointV1) -> ExecutorResult<()> {
    let fingerprint = non_empty_string(&checkpoint.endpoint_fingerprint, "endpointFingerprint")?;
    if fingerprint.len() != 64 || !fingerprint.bytes().all(is_lower_hex) {
        return Err(type_error(
            "Direct Responses checkpoint fingerprint is invalid",
        ));
    }
    non_empty_string(&checkpoint.response_id, "responseId")?;
    non_empty_string(&checkpoint.endpoint_id, "endpointId")?;
    non_empty_string(&checkpoint.model, "model")?;
    Ok(())
}

fn open_options_without_symlink() -> OpenOptions {
    let mut open = OpenOptions::new();
    #[cfg(unix)]
    open.custom_flags(libc::O_NOFOLLOW);
    #[cfg(windows)]
    open.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    open
}

async fn open_regular_file(path: &str, write: bool) -> ExecutorResult<File> {
    let file = open_options_without_symlink()
        .read(true)
        .write(write)
        .open(path)
        .await?;
    let metadata = file.metadata().await?;
    #[cfg(windows)]
    if metadata.is_symlink() {
        return Err(io::Error::from_raw_os_error(1921).into());
    }
    if !metadata.is_file() {
        return Err(type_error("Direct session source is not a regular file"));
    }
    Ok(file)
}

async fn write_all(file: &mut File, bytes: &[u8], offset: u64) -> ExecutorResult<()> {
    file.seek(SeekFrom::Start(offset)).await?;
    let mut written = 0;
    while written < bytes.len() {
        let count = file.write(&bytes[written..]).await?;
        if count == 0 {
            return Err("Direct session append made no progress".into());
        }
        written += count;
    }
    Ok(())
}

fn type_error(message: impl Into<String>) -> Box<dyn std::error::Error> {
    NamedError {
        name: "TypeError".into(),
        code: None,
        message: message.into(),
    }
    .into()
}

fn require_session_id(value: Option<&str>) -> ExecutorResult<&str> {
    let value = value.filter(|id| {
        let bytes = id.as_bytes();
        bytes.len() == 36
            && bytes.iter().enumerate().all(|(index, byte)| match index {
                8 | 13 | 18 | 23 => *byte == b'-',
                14 => *byte == b'4',
                19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
                _ => is_lower_hex(*byte),
            })
    });
    value.ok_or_else(|| type_error("Direct session ID is invalid"))
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn require_string<'a>(
    value: &'a Value,
    raw: Option<&RawValue>,
    field: &str,
) -> ExecutorResult<&'a str> {
    value
        .as_str()
        .filter(|_| !malformed_unicode(raw))
        .ok_or_else(|| type_error(format!("Direct session {field} is invalid")))
}

fn require_non_empty_string<'a>(
    value: &'a Value,
    raw: Option<&RawValue>,
    field: &str,
) -> ExecutorResult<&'a str> {
    non_empty_string(require_string(value, raw, field)?, field)
}

fn non_empty_string<'a>(value: &'a str, field: &str) -> ExecutorResult<&'a str> {
    if value.is_empty() {
        return Err(type_error(format!("Direct session {field} is empty")));
    }
    Ok(value)
}

fn require_timestamp<'a>(
    value: &'a Value,
    raw: Option<&RawValue>,
    field: &str,
) -> ExecutorResult<&'a str> {
    require_timestamp_str(require_non_empty_string(value, raw, field)?, field)
}

fn require_timestamp_str<'a>(value: &'a str, field: &str) -> ExecutorResult<&'a str> {
    if date_parse(value)
        .and_then(|epoch| to_iso_string(epoch).ok())
        .as_deref()
        != Some(value)
    {
        return Err(type_error(format!("Direct session {field} is invalid")));
    }
    Ok(value)
}

fn has_exact_keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
    })
}

fn parse_header(line: &ParsedLine<'_>) -> ExecutorResult<DirectSessionHeaderV1> {
    let value = &line.value;
    if !has_exact_keys(
        value,
        &["type", "schemaVersion", "ownerId", "sessionId", "createdAt"],
    ) {
        return Err(type_error("Direct session header is invalid"));
    }
    if value["type"].as_str() != Some("session")
        || json::as_number(&value["schemaVersion"]) != Some(DIRECT_SESSION_SCHEMA_VERSION as f64)
    {
        return Err(type_error("Direct session header schema is unsupported"));
    }
    let fields = raw_fields(line.raw);
    Ok(DirectSessionHeaderV1 {
        schema_version: DIRECT_SESSION_SCHEMA_VERSION,
        owner_id: require_non_empty_string(
            &value["ownerId"],
            fields.get("ownerId").copied(),
            "ownerId",
        )?
        .to_owned(),
        session_id: require_session_id(value["sessionId"].as_str())?.to_owned(),
        created_at: require_timestamp(
            &value["createdAt"],
            fields.get("createdAt").copied(),
            "createdAt",
        )?
        .to_owned(),
    })
}

fn parse_session_record(line: &ParsedLine<'_>) -> ExecutorResult<DirectSessionRecordV1> {
    let value = &line.value;
    if !value.is_object() {
        return Err(type_error("Direct session record is invalid"));
    }
    match value["type"].as_str() {
        Some("user") => parse_user_record(value, line.raw).map(DirectSessionRecordV1::User),
        Some("assistant") => {
            parse_assistant_record(value, line.raw).map(DirectSessionRecordV1::Assistant)
        }
        _ => Err(type_error("Direct session record type is unsupported")),
    }
}

fn parse_user_record(value: &Value, raw: Option<&str>) -> ExecutorResult<DirectUserRecordV1> {
    if !has_exact_keys(value, &["type", "at", "runId", "content", "attachments"]) {
        return Err(type_error("Direct user record is invalid"));
    }
    let fields = raw_fields(raw);
    let content = require_string(&value["content"], fields.get("content").copied(), "content")?;
    let attachments = parse_attachments(&value["attachments"], fields.get("attachments").copied())?;
    if content.is_empty() && attachments.is_empty() {
        return Err(type_error(
            "Direct user record requires content or attachments",
        ));
    }
    Ok(DirectUserRecordV1 {
        at: require_timestamp(&value["at"], fields.get("at").copied(), "at")?.to_owned(),
        run_id: require_non_empty_string(&value["runId"], fields.get("runId").copied(), "runId")?
            .to_owned(),
        content: content.to_owned(),
        attachments,
    })
}

fn parse_assistant_record(
    value: &Value,
    raw: Option<&str>,
) -> ExecutorResult<DirectAssistantRecordV1> {
    if !has_exact_keys(value, &["type", "at", "runId", "content", "checkpoint"]) {
        return Err(type_error("Direct assistant record is invalid"));
    }
    let fields = raw_fields(raw);
    let content = require_string(&value["content"], fields.get("content").copied(), "content")?;
    if trim(content).is_empty() {
        return Err(type_error("Direct assistant record content is empty"));
    }
    Ok(DirectAssistantRecordV1 {
        at: require_timestamp(&value["at"], fields.get("at").copied(), "at")?.to_owned(),
        run_id: require_non_empty_string(&value["runId"], fields.get("runId").copied(), "runId")?
            .to_owned(),
        content: content.to_owned(),
        checkpoint: (!value["checkpoint"].is_null())
            .then(|| {
                parse_checkpoint(
                    &value["checkpoint"],
                    fields.get("checkpoint").map(|raw| raw.get()),
                )
            })
            .transpose()?,
    })
}

fn parse_checkpoint(
    value: &Value,
    raw: Option<&str>,
) -> ExecutorResult<DirectResponsesCheckpointV1> {
    if !has_exact_keys(
        value,
        &[
            "kind",
            "responseId",
            "endpointId",
            "endpointFingerprint",
            "model",
        ],
    ) {
        return Err(type_error("Direct Responses checkpoint is invalid"));
    }
    let fields = raw_fields(raw);
    let field = |key| require_non_empty_string(&value[key], fields.get(key).copied(), key);
    let fingerprint = field("endpointFingerprint")?;
    if fingerprint.len() != 64 || !fingerprint.bytes().all(is_lower_hex) {
        return Err(type_error(
            "Direct Responses checkpoint fingerprint is invalid",
        ));
    }
    if value["kind"].as_str() != Some("openai-response") {
        return Err(type_error("Direct Responses checkpoint kind is invalid"));
    }
    Ok(DirectResponsesCheckpointV1 {
        response_id: field("responseId")?.to_owned(),
        endpoint_id: field("endpointId")?.to_owned(),
        endpoint_fingerprint: fingerprint.to_owned(),
        model: field("model")?.to_owned(),
    })
}

fn parse_attachments(
    value: &Value,
    raw: Option<&RawValue>,
) -> ExecutorResult<Vec<AgentAttachment>> {
    let list = value
        .as_array()
        .ok_or_else(|| type_error("Direct user attachments are invalid"))?;
    let raw_attachments = parse_raw::<Vec<&RawValue>>(raw.map(RawValue::get)).unwrap_or_default();
    list.iter()
        .enumerate()
        .map(|(index, attachment)| {
            if !has_exact_keys(attachment, &["kind", "data", "name", "mimeType"]) {
                return Err(type_error("Direct user attachment is invalid"));
            }
            if attachment["kind"].as_str() != Some("image") {
                return Err(type_error("Direct user attachment kind is invalid"));
            }
            let fields = raw_fields(raw_attachments.get(index).map(|raw| raw.get()));
            let name = match &attachment["name"] {
                Value::Null => None,
                Value::String(_) if malformed_unicode(fields.get("name").copied()) => {
                    return Err(type_error(
                        "Direct user attachment name contains malformed Unicode",
                    ));
                }
                Value::String(name) => Some(name.clone()),
                _ => return Err(type_error("Direct user attachment name is invalid")),
            };
            Ok(AgentAttachment {
                kind: AgentAttachmentKind::Image,
                data: require_non_empty_string(
                    &attachment["data"],
                    fields.get("data").copied(),
                    "attachment data",
                )?
                .to_owned(),
                name,
                mime_type: require_non_empty_string(
                    &attachment["mimeType"],
                    fields.get("mimeType").copied(),
                    "attachment MIME type",
                )?
                .to_owned(),
            })
        })
        .collect()
}

impl DirectSessionRuns {
    fn validate(&self, record: &DirectSessionRecordV1) -> ExecutorResult<()> {
        match record {
            DirectSessionRecordV1::User(record) if self.user_run_ids.contains(&record.run_id) => {
                Err(type_error("Direct session contains a duplicate user run"))
            }
            DirectSessionRecordV1::Assistant(record)
                if !self.user_run_ids.contains(&record.run_id) =>
            {
                Err(type_error(
                    "Direct assistant record has no preceding user record",
                ))
            }
            DirectSessionRecordV1::Assistant(record)
                if self.assistant_run_ids.contains(&record.run_id) =>
            {
                Err(type_error(
                    "Direct session contains a duplicate assistant run",
                ))
            }
            _ => Ok(()),
        }
    }

    fn accept(&mut self, record: &DirectSessionRecordV1) {
        match record {
            DirectSessionRecordV1::User(record) => self.user_run_ids.insert(record.run_id.clone()),
            DirectSessionRecordV1::Assistant(record) => {
                self.assistant_run_ids.insert(record.run_id.clone())
            }
        };
    }
}

struct ParsedLine<'a> {
    value: Value,
    raw: Option<&'a str>,
}

fn malformed_unicode(raw: Option<&RawValue>) -> bool {
    raw.is_some_and(|raw| json::contains_unpaired_surrogate_escape(raw.get().as_bytes()))
}

fn raw_fields(raw: Option<&str>) -> HashMap<String, &RawValue> {
    parse_raw(raw).unwrap_or_default()
}

#[expect(
    clippy::disallowed_methods,
    reason = "keeps the original raw field tokens solely for well-formed Unicode validation"
)]
fn parse_raw<'a, T: Deserialize<'a>>(raw: Option<&'a str>) -> Option<T> {
    serde_json::from_str(raw?).ok()
}

fn parse_json_line(bytes: &[u8], line_number: usize) -> ExecutorResult<ParsedLine<'_>> {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let line = std::str::from_utf8(bytes)
        .map_err(|_| type_error("Direct session contains invalid UTF-8"))?;
    if line.is_empty() {
        return Err(type_error(format!(
            "Direct session record {line_number} is empty"
        )));
    }
    let value = json::parse(line)
        .map_err(|_| type_error(format!("Direct session record {line_number} is malformed")))?;
    // A damaged file must not be normalized and then accepted as the next append base.
    let raw = json::contains_unpaired_surrogate_escape(bytes).then_some(line);
    Ok(ParsedLine { value, raw })
}

fn validate_session_header(
    raw: &[u8],
    expected_owner_id: &str,
    expected_session_id: &str,
) -> ExecutorResult<DirectSessionHeaderV1> {
    let header = parse_header(&parse_json_line(raw, 1)?)?;
    if header.owner_id != expected_owner_id || header.session_id != expected_session_id {
        return Err(type_error(
            "Direct session header does not match the selected session",
        ));
    }
    Ok(header)
}

async fn parse_session_file(
    raw: &[u8],
    expected_owner_id: &str,
    expected_session_id: &str,
) -> ExecutorResult<ParsedSessionFile> {
    let complete = raw
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    if complete == 0 {
        return Err(type_error("Direct session is missing its header"));
    }
    let mut lines = raw[..complete - 1].split(|byte| *byte == b'\n');
    let header = validate_session_header(
        lines.next().unwrap_or_default(),
        expected_owner_id,
        expected_session_id,
    )?;
    let mut records = Vec::new();
    let mut runs = DirectSessionRuns::default();
    let mut steps = EventLoopSteps::new("direct-session-parse");
    for (index, line) in lines.enumerate() {
        let record = parse_session_record(&parse_json_line(line, index + 2)?)?;
        runs.validate(&record)?;
        runs.accept(&record);
        records.push(record);
        steps.next().await;
    }
    let mut append_offset = raw.len() as u64;
    let mut ignored_tail = false;
    let mut separator = false;
    if complete < raw.len() {
        let record = parse_json_line(&raw[complete..], records.len() + 2)
            .and_then(|line| parse_session_record(&line));
        match record {
            Ok(record) if runs.validate(&record).is_ok() => {
                runs.accept(&record);
                records.push(record);
                separator = true;
            }
            _ => {
                append_offset = complete as u64;
                ignored_tail = true;
            }
        }
    }
    if !matches!(records.first(), Some(DirectSessionRecordV1::User(_))) {
        return Err(type_error(
            "Direct session is missing its first user record",
        ));
    }
    Ok(ParsedSessionFile {
        header,
        records,
        append_offset,
        separator,
        ignored_tail,
        runs,
    })
}

#[cfg(test)]
pub(super) mod tests;
