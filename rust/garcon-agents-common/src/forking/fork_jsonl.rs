use std::{io, rc::Rc};

use futures::future::LocalBoxFuture;
use garcon_base::{
    errors::{ErrorInput, NamedError, has_node_error_code},
    file_stat::FileIdentity,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Clock, SystemClock, json::Opaque, path::native as path, utf16};
use indexmap::IndexMap;
use sha2::{Digest, Sha256};
use tokio::{
    fs::{self, File},
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Take},
};

use crate::jsonl::{JsonlLineResult, parse_first_jsonl_value};

#[derive(Clone)]
pub struct ForkTranscriptEntryContext {
    pub source_agent_session_id: String,
    pub target_agent_session_id: String,
    pub retained_message_count: Option<u64>,
}

pub struct ForkTranscriptTransformInput {
    pub selected_entries: Vec<Opaque>,
    pub source_entries: Vec<Opaque>,
    pub source_agent_session_id: String,
    pub target_agent_session_id: String,
}

pub struct ForkTranscriptTransformResult {
    pub entries: Vec<Opaque>,
    pub expected_semantic_digest: Option<String>,
}

pub struct ForkJsonlTargetPathInput {
    pub source_path: String,
    pub target_agent_session_id: String,
    pub created_at_ms: i64,
}

pub enum ForkEntryRewrite {
    Unchanged,
    Replace(Opaque),
    Undefined,
}

pub type RewriteEntry =
    dyn Fn(&Opaque, &ForkTranscriptEntryContext) -> ExecutorResult<ForkEntryRewrite>;
pub type TransformEntries =
    dyn Fn(
        ForkTranscriptTransformInput,
    ) -> LocalBoxFuture<'static, ExecutorResult<ForkTranscriptTransformResult>>;
pub type CreateTargetPath = dyn Fn(ForkJsonlTargetPathInput) -> String;

pub struct ForkJsonlRequest {
    pub source_path: String,
    pub source_agent_session_id: String,
    pub cutoff_line: Option<f64>,
    pub allow_unmaterialized_whole_session: bool,
    pub leading_line_count: Option<f64>,
    pub retained_message_counts: IndexMap<u64, u64>,
    pub rewrite_entry: Option<Rc<RewriteEntry>>,
    pub transform_entries: Option<Rc<TransformEntries>>,
    pub create_target_path: Option<Rc<CreateTargetPath>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ForkJsonlOutcome {
    Materialized {
        agent_session_id: String,
        native_path: String,
        expected_semantic_digest: Option<String>,
    },
    Unmaterialized,
}

#[derive(Debug, thiserror::Error)]
#[error("Source transcript prefix changed while reading: {0}")]
pub struct JsonlSourcePrefixChangedError(pub String);

impl garcon_base::errors::DiagnosticError for JsonlSourcePrefixChangedError {
    fn diagnostic_metadata(&self) -> garcon_base::errors::ErrorMetadata<'_> {
        garcon_base::errors::ErrorMetadata {
            code: None,
            name: "JsonlSourcePrefixChangedError",
        }
    }
}

const READ_CHUNK_BYTES: usize = 64 * 1024;
const WRITE_BATCH_BYTES: usize = 1024 * 1024;

pub async fn fork_jsonl_transcript(request: ForkJsonlRequest) -> ExecutorResult<ForkJsonlOutcome> {
    fork_jsonl_transcript_with(request, &SystemClock, || uuid::Uuid::new_v4().to_string()).await
}

pub async fn fork_jsonl_transcript_with(
    request: ForkJsonlRequest,
    clock: &dyn Clock,
    new_session_id: impl FnOnce() -> String,
) -> ExecutorResult<ForkJsonlOutcome> {
    let context = ForkTranscriptEntryContext {
        source_agent_session_id: request.source_agent_session_id.clone(),
        target_agent_session_id: new_session_id(),
        retained_message_count: None,
    };
    let mut target = TargetWriter::new(|| {
        if let Some(create_path) = &request.create_target_path {
            create_path(ForkJsonlTargetPathInput {
                source_path: request.source_path.clone(),
                target_agent_session_id: context.target_agent_session_id.clone(),
                created_at_ms: clock.now_ms(),
            })
        } else {
            path::join(&[
                &path::dirname(&request.source_path),
                &format!("{}.jsonl", context.target_agent_session_id),
            ])
        }
    });
    let result = fork_into_target(&request, &context, &mut target).await;
    if result.is_err() {
        target.remove().await;
    }
    result
}

async fn fork_into_target(
    request: &ForkJsonlRequest,
    context: &ForkTranscriptEntryContext,
    target: &mut TargetWriter<impl Fn() -> String>,
) -> ExecutorResult<ForkJsonlOutcome> {
    let SourceRead { entries, digest } = if request.cutoff_line.is_none() {
        read_whole_session(request, context, target).await?
    } else {
        read_retained_prefix(request, context, target).await?
    };
    let transformed = if let Some(transform) = &request.transform_entries {
        Some(
            transform(ForkTranscriptTransformInput {
                selected_entries: entries.selected,
                source_entries: entries.source,
                source_agent_session_id: context.source_agent_session_id.clone(),
                target_agent_session_id: context.target_agent_session_id.clone(),
            })
            .await?,
        )
    } else {
        None
    };
    if request.allow_unmaterialized_whole_session
        && transformed
            .as_ref()
            .map_or(entries.selected_count, |result| result.entries.len())
            == 0
    {
        if request.cutoff_line.is_some() {
            return Err("Only whole-session JSONL forks can remain unmaterialized".into());
        }
        target.remove().await;
        verify_source(request, &digest).await?;
        return Ok(ForkJsonlOutcome::Unmaterialized);
    }
    let expected_semantic_digest = if let Some(transformed) = transformed {
        for value in transformed.entries {
            let serialized = serde_json::to_string(&value).map_err(|_| {
                format!(
                    "Fork transcript transformer returned a non-JSON value for {}",
                    request.source_path
                )
            })?;
            target.line(&serialized).await?;
        }
        transformed.expected_semantic_digest
    } else {
        None
    };
    let native_path = target.finish().await?;
    verify_source(request, &digest).await?;
    Ok(ForkJsonlOutcome::Materialized {
        agent_session_id: context.target_agent_session_id.clone(),
        native_path,
        expected_semantic_digest,
    })
}

struct ForkEntries {
    retain: bool,
    selected: Vec<Opaque>,
    source: Vec<Opaque>,
    selected_count: usize,
}

impl ForkEntries {
    fn new(retain: bool) -> Self {
        Self {
            retain,
            selected: Vec::new(),
            source: Vec::new(),
            selected_count: 0,
        }
    }
    fn add_source(&mut self, value: &Opaque) {
        if self.retain {
            self.source.push(value.clone());
        }
    }
    fn add_selected(&mut self, value: Opaque) {
        self.selected_count += 1;
        if self.retain {
            self.selected.push(value);
        }
    }
}

struct SourceRead {
    entries: ForkEntries,
    digest: SourceDigest,
}

fn changed(request: &ForkJsonlRequest) -> JsonlSourcePrefixChangedError {
    JsonlSourcePrefixChangedError(request.source_path.clone())
}

fn invalid_jsonl(request: &ForkJsonlRequest, line_number: u64) -> String {
    format!("Invalid JSONL at {}:{line_number}", request.source_path)
}

fn not_found(error: &io::Error) -> bool {
    has_node_error_code(ErrorInput::Error(error), "ENOENT")
}

#[cfg(unix)]
async fn stat_source(path: &str) -> io::Result<FileIdentity> {
    Ok(garcon_base::file_stat::stat_from_metadata(fs::metadata(path).await?).identity)
}

#[cfg(windows)]
async fn stat_source(path: &str) -> io::Result<FileIdentity> {
    let file = File::open(path).await?;
    Ok(garcon_base::file_stat::stat_handle(&file).await?.identity)
}

async fn read_whole_session(
    request: &ForkJsonlRequest,
    context: &ForkTranscriptEntryContext,
    target: &mut TargetWriter<impl Fn() -> String>,
) -> ExecutorResult<SourceRead> {
    let transforms = request.transform_entries.is_some();
    let mut entries = ForkEntries::new(transforms);
    let mut hash = PrefixHash::default();
    let before = match stat_source(&request.source_path).await {
        Ok(identity) => identity,
        Err(error) if request.allow_unmaterialized_whole_session && not_found(&error) => {
            return Ok(SourceRead {
                entries,
                digest: hash.digest(),
            });
        }
        Err(error) => return Err(error.into()),
    };
    let limit = u64::try_from(before.size)?;
    let file = File::open(&request.source_path).await?;
    let mut lines = PhysicalLines::new(file, Some(limit));
    let mut empty = 0;
    let mut incomplete = None;
    while lines.advance().await? {
        hash.add(&lines);
        let text = String::from_utf8_lossy(&lines.bytes);
        let parsed = parse_first_jsonl_value(&text);
        if matches!(parsed, JsonlLineResult::Empty) {
            empty += 1;
            continue;
        }
        if let Some(line) = incomplete {
            return Err(invalid_jsonl(request, line).into());
        }
        if matches!(parsed, JsonlLineResult::Invalid { .. }) {
            return Err(invalid_jsonl(request, lines.number).into());
        }
        if !transforms {
            for _ in 0..empty {
                target.line("").await?;
            }
        }
        empty = 0;
        match parsed {
            JsonlLineResult::Incomplete => incomplete = Some(lines.number),
            JsonlLineResult::Value { value, raw, .. } => {
                entries.add_source(&value);
                let (value, serialized) = project(request, context, value, raw, lines.number)?;
                entries.add_selected(value);
                if !transforms {
                    target.line(&serialized).await?;
                }
            }
            JsonlLineResult::Empty | JsonlLineResult::Invalid { .. } => {}
        }
    }
    drop(lines);
    let after = stat_source(&request.source_path).await?;
    if source_changed_during_read(before, after) {
        return Err(changed(request).into());
    }
    Ok(SourceRead {
        entries,
        digest: hash.digest(),
    })
}

async fn read_retained_prefix(
    request: &ForkJsonlRequest,
    context: &ForkTranscriptEntryContext,
    target: &mut TargetWriter<impl Fn() -> String>,
) -> ExecutorResult<SourceRead> {
    let count = retained_line_count(request)?;
    let transforms = request.transform_entries.is_some();
    let mut hash = PrefixHash::default();
    let mut entries = ForkEntries::new(transforms);
    let mut retained = 0;
    let mut incomplete = None;
    let mut lines = PhysicalLines::new(File::open(&request.source_path).await?, None);
    while lines.advance().await? {
        if lines.number > count && !transforms {
            break;
        }
        if lines.number <= count {
            retained = lines.number;
            hash.add(&lines);
        }
        let text = String::from_utf8_lossy(&lines.bytes);
        let parsed = parse_first_jsonl_value(&text);
        if lines.number > count {
            if matches!(parsed, JsonlLineResult::Empty) {
                continue;
            }
            if let Some(line) = incomplete {
                return Err(invalid_jsonl(request, line).into());
            }
            match parsed {
                JsonlLineResult::Incomplete => incomplete = Some(lines.number),
                JsonlLineResult::Value { value, .. } => entries.add_source(&value),
                _ => return Err(invalid_jsonl(request, lines.number).into()),
            }
        } else {
            match parsed {
                JsonlLineResult::Empty => {
                    if !transforms {
                        target.line("").await?;
                    }
                }
                JsonlLineResult::Value { value, raw, .. } => {
                    entries.add_source(&value);
                    let (value, serialized) = project(request, context, value, raw, lines.number)?;
                    entries.add_selected(value);
                    if !transforms {
                        target.line(&serialized).await?;
                    }
                }
                _ => return Err(changed(request).into()),
            }
        }
    }
    if retained < count {
        return Err(changed(request).into());
    }
    Ok(SourceRead {
        entries,
        digest: hash.digest(),
    })
}

fn retained_line_count(request: &ForkJsonlRequest) -> Result<u64, JsonlSourcePrefixChangedError> {
    let line = request.cutoff_line.ok_or_else(|| changed(request))?;
    let count = if line == 0.0 {
        request.leading_line_count.unwrap_or_default()
    } else {
        line
    };
    if !garcon_js::is_safe_integer(count) || count < 0.0 {
        return Err(changed(request));
    }
    Ok(count as u64)
}

fn project(
    request: &ForkJsonlRequest,
    context: &ForkTranscriptEntryContext,
    value: Opaque,
    raw: String,
    number: u64,
) -> ExecutorResult<(Opaque, String)> {
    let Some(rewrite) = &request.rewrite_entry else {
        return Ok((value, raw));
    };
    let mut context = context.clone();
    context.retained_message_count = request.retained_message_counts.get(&number).copied();
    let non_json = || {
        format!(
            "Fork transcript rewriter returned a non-JSON value at {}:{number}",
            request.source_path
        )
    };
    match rewrite(&value, &context)? {
        ForkEntryRewrite::Unchanged => Ok((value, raw)),
        ForkEntryRewrite::Replace(value) => {
            let serialized = serde_json::to_string(&value).map_err(|_| non_json())?;
            Ok((value, serialized))
        }
        ForkEntryRewrite::Undefined => Err(non_json().into()),
    }
}

async fn verify_source(request: &ForkJsonlRequest, expected: &SourceDigest) -> ExecutorResult<()> {
    if request.cutoff_line.is_none() {
        return verify_whole_session_prefix(request, expected).await;
    }
    let line_count = retained_line_count(request)?;
    let file =
        File::open(&request.source_path)
            .await
            .map_err(|error| -> Box<dyn std::error::Error> {
                if not_found(&error) {
                    changed(request).into()
                } else {
                    error.into()
                }
            })?;
    let mut lines = PhysicalLines::new(file, None);
    let mut hash = PrefixHash::default();
    let mut retained = 0;
    while lines.advance().await? && lines.number <= line_count {
        hash.add(&lines);
        retained = lines.number;
    }
    let current = hash.digest();
    if retained < line_count
        || current.prefix_length != expected.prefix_length
        || current.prefix_digest != expected.prefix_digest
        || (expected.terminated && !current.terminated)
    {
        return Err(changed(request).into());
    }
    Ok(())
}

async fn verify_whole_session_prefix(
    request: &ForkJsonlRequest,
    expected: &SourceDigest,
) -> ExecutorResult<()> {
    let mut file = match File::open(&request.source_path).await {
        Ok(file) => file.take(expected.byte_length),
        Err(error)
            if not_found(&error)
                && request.allow_unmaterialized_whole_session
                && expected.byte_length == 0 =>
        {
            return Ok(());
        }
        Err(error) if not_found(&error) => return Err(changed(request).into()),
        Err(error) => return Err(error.into()),
    };
    let mut hash = Sha256::new();
    let mut length = 0;
    let mut buffer = vec![0; READ_CHUNK_BYTES];
    loop {
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        length += read as u64;
    }
    let digest: [u8; 32] = hash.finalize().into();
    if length != expected.byte_length || digest != expected.byte_digest {
        return Err(changed(request).into());
    }
    Ok(())
}

struct PhysicalLines {
    reader: BufReader<Take<File>>,
    bytes: Vec<u8>,
    number: u64,
    terminated: bool,
}

impl PhysicalLines {
    fn new(file: File, limit: Option<u64>) -> Self {
        Self {
            reader: BufReader::with_capacity(
                READ_CHUNK_BYTES,
                file.take(limit.unwrap_or(u64::MAX)),
            ),
            bytes: Vec::new(),
            number: 0,
            terminated: true,
        }
    }

    async fn advance(&mut self) -> io::Result<bool> {
        self.bytes.clear();
        if self.reader.read_until(b'\n', &mut self.bytes).await? == 0 {
            return Ok(false);
        }
        self.number += 1;
        self.terminated = self.bytes.last() == Some(&b'\n');
        if self.terminated {
            self.bytes.pop();
        }
        Ok(true)
    }
}

struct SourceDigest {
    prefix_length: u64,
    prefix_digest: [u8; 32],
    terminated: bool,
    byte_length: u64,
    byte_digest: [u8; 32],
}

#[derive(Default)]
struct PrefixHash {
    prefix: Sha256,
    bytes: Sha256,
    prefix_length: u64,
    pending_terminator: bool,
}

impl PrefixHash {
    fn add(&mut self, line: &PhysicalLines) {
        if self.pending_terminator {
            self.prefix.update(b"\n");
            self.prefix_length += 1;
        }
        self.prefix.update(&line.bytes);
        self.bytes.update(&line.bytes);
        self.prefix_length += line.bytes.len() as u64;
        if line.terminated {
            self.bytes.update(b"\n");
        }
        self.pending_terminator = line.terminated;
    }

    fn digest(self) -> SourceDigest {
        SourceDigest {
            prefix_length: self.prefix_length,
            prefix_digest: self.prefix.finalize().into(),
            terminated: self.pending_terminator || self.prefix_length == 0,
            byte_length: self.prefix_length + u64::from(self.pending_terminator),
            byte_digest: self.bytes.finalize().into(),
        }
    }
}

struct TargetWriter<F> {
    path: Option<String>,
    file: Option<File>,
    batch: Vec<u8>,
    batch_units: usize,
    create_path: F,
}

impl<F: Fn() -> String> TargetWriter<F> {
    fn new(create_path: F) -> Self {
        Self {
            path: None,
            file: None,
            batch: Vec::new(),
            batch_units: 0,
            create_path,
        }
    }

    async fn line(&mut self, text: &str) -> ExecutorResult<()> {
        self.batch.extend_from_slice(text.as_bytes());
        self.batch.push(b'\n');
        self.batch_units += utf16::len(text) + 1;
        if self.batch_units >= WRITE_BATCH_BYTES {
            self.flush().await?;
        }
        Ok(())
    }

    async fn finish(&mut self) -> ExecutorResult<String> {
        self.flush().await?;
        self.open().await?;
        self.file.take();
        self.path
            .clone()
            .ok_or_else(|| io::Error::other("Fork target path was not created").into())
    }

    async fn remove(&mut self) {
        self.batch.clear();
        self.batch_units = 0;
        self.file.take();
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path).await;
        }
    }

    async fn open(&mut self) -> ExecutorResult<()> {
        if self.file.is_some() {
            return Ok(());
        }
        let path = (self.create_path)();
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = match options.open(&path).await {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(NamedError {
                    name: "Error".to_owned(),
                    code: Some("EEXIST".to_owned()),
                    message: format!("EEXIST: file already exists, open '{path}'"),
                }
                .into());
            }
            Err(error) => return Err(error.into()),
        };
        // Unlike the original, cleanup owns the path only after exclusive creation succeeds.
        self.path = Some(path);
        self.file = Some(file);
        Ok(())
    }

    async fn flush(&mut self) -> ExecutorResult<()> {
        if self.batch.is_empty() {
            return Ok(());
        }
        self.open().await?;
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("Fork target file was not opened"))?;
        file.write_all(&self.batch).await?;
        file.flush().await?;
        self.batch.clear();
        self.batch_units = 0;
        Ok(())
    }
}

fn source_changed_during_read(before: FileIdentity, after: FileIdentity) -> bool {
    if before.dev != after.dev || before.ino != after.ino {
        return true;
    }
    if after.size > before.size {
        return false;
    }
    before.size != after.size || before.mtime_ns != after.mtime_ns
}

#[cfg(test)]
mod tests;
