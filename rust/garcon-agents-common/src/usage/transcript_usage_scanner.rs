use std::{
    collections::{HashMap, HashSet},
    io,
    rc::Rc,
    time::UNIX_EPOCH,
};

use async_compression::tokio::bufread::ZstdDecoder;
use futures::{StreamExt, stream};
use garcon_base::{
    errors::{ErrorInput, has_node_error_code},
    event_loop::EventLoopSteps,
    keyed_lock::LockAborted,
};
use garcon_contract::usage::USAGE_RETENTION_DAYS;
use garcon_interface::resources::ExecutorResult;
use garcon_js::{
    clock::{Clock, SystemClock},
    utf16,
};
use indexmap::IndexSet;
use memchr::{memchr, memmem::Finder};
use tokio::{
    fs::{self, File},
    io::{AsyncRead, AsyncReadExt, AsyncSeekExt, BufReader, SeekFrom},
};
use tokio_util::sync::CancellationToken;

use super::usage_record::{
    MalformedUsage, TranscriptUsageFormat, UsageLine, UsageRecord, merge_usage_copies,
};

const READ_CHUNK_BYTES: usize = 256 * 1024;
const STAT_CONCURRENCY: usize = 16;
const MAX_DIRECTORY_DEPTH: usize = 6;
const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
const RETENTION_MS: i64 = USAGE_RETENTION_DAYS as i64 * 86_400_000;
const GUARD_BYTES: usize = 64;
const PLAIN_SUFFIX: &str = ".jsonl";
const COMPRESSED_SUFFIX: &str = ".jsonl.zst";

struct TranscriptFile {
    path: String,
    size: u64,
    mtime_ms: f64,
}

struct CachedTranscript<State> {
    size: u64,
    mtime_ms: f64,
    records: ScannedTranscript,
    key_index: HashMap<String, usize>,
    oldest_ms: i64,
    resume_offset: u64,
    guard_hash: u32,
    state: State,
}

#[derive(Default)]
pub struct ScannedTranscript {
    pub records: Vec<UsageRecord>,
    pub tail_records: Vec<UsageRecord>,
    pub malformed: Vec<MalformedUsage>,
}

pub struct TranscriptUsageScan<'a> {
    pub root_found: bool,
    pub files: Vec<&'a ScannedTranscript>,
    pub unreadable_paths: u64,
}

pub struct TranscriptUsageScannerOptions<F> {
    pub operation: String,
    pub format: F,
    pub roots: Rc<dyn Fn() -> Vec<String>>,
    pub clock: Option<Rc<dyn Clock>>,
}

struct ParsedLines<State> {
    records: Vec<UsageRecord>,
    malformed: Vec<MalformedUsage>,
    tail_records: Vec<UsageRecord>,
    resume_offset: u64,
    state: State,
}

enum ReadTranscript<State> {
    Read {
        parsed: ParsedLines<State>,
        resume: bool,
        guard_hash: u32,
    },
    Gone,
    Unreadable,
}

pub struct TranscriptUsageScanner<F: TranscriptUsageFormat> {
    options: TranscriptUsageScannerOptions<F>,
    cache: HashMap<String, CachedTranscript<F::State>>,
}

impl<F: TranscriptUsageFormat> TranscriptUsageScanner<F> {
    pub fn new(options: TranscriptUsageScannerOptions<F>) -> Self {
        Self {
            options,
            cache: HashMap::new(),
        }
    }

    pub fn operation(&self) -> &str {
        &self.options.operation
    }

    pub async fn scan(
        &mut self,
        since_ms: i64,
        steps: &mut EventLoopSteps,
        signal: Option<&CancellationToken>,
    ) -> ExecutorResult<TranscriptUsageScan<'_>> {
        check_abort(signal)?;
        let listing = list_transcripts((self.options.roots)(), signal).await?;
        let retained_since_ms = self
            .options
            .clock
            .as_deref()
            .unwrap_or(&SystemClock)
            .now_ms()
            - RETENTION_MS;
        let existing: HashMap<_, _> = listing
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.mtime_ms))
            .collect();
        let unstatable: HashSet<_> = listing
            .unstatable_paths
            .iter()
            .map(String::as_str)
            .collect();
        self.cache.retain(|path, cached| {
            let mtime = if unstatable.contains(path.as_str()) {
                Some(cached.mtime_ms)
            } else {
                existing.get(path.as_str()).copied()
            };
            mtime.is_some_and(|mtime| mtime >= retained_since_ms as f64)
        });

        let mut paths = Vec::new();
        let mut unreadable_paths = listing.unreadable_paths;
        for file in listing.files {
            if file.mtime_ms < since_ms as f64 {
                continue;
            }
            check_abort(signal)?;
            let cached = self.cache.get(&file.path);
            if cached
                .is_none_or(|cached| cached.size != file.size || cached.mtime_ms != file.mtime_ms)
            {
                match read_transcript(&self.options.format, &file, cached, steps, signal).await? {
                    ReadTranscript::Read {
                        parsed,
                        resume,
                        guard_hash,
                    } => {
                        let base = if resume {
                            self.cache.remove(&file.path)
                        } else {
                            None
                        };
                        let merged = merge_records(
                            base,
                            parsed,
                            &file,
                            guard_hash,
                            retained_since_ms,
                            steps,
                        )
                        .await;
                        self.cache.insert(file.path.clone(), merged);
                    }
                    ReadTranscript::Gone => {
                        self.cache.remove(&file.path);
                        unreadable_paths += 1;
                        continue;
                    }
                    ReadTranscript::Unreadable => {
                        unreadable_paths += 1;
                        if cached.is_none() {
                            continue;
                        }
                    }
                }
            }
            paths.push(file.path);
        }
        paths.extend(listing.unstatable_paths);
        let files = paths
            .into_iter()
            .filter_map(|path| self.cache.get(&path).map(|cached| &cached.records))
            .collect();
        Ok(TranscriptUsageScan {
            root_found: listing.root_found,
            files,
            unreadable_paths,
        })
    }
}

async fn read_transcript<F: TranscriptUsageFormat>(
    format: &F,
    file: &TranscriptFile,
    cached: Option<&CachedTranscript<F::State>>,
    steps: &mut EventLoopSteps,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<ReadTranscript<F::State>> {
    let mut handle = match File::open(&file.path).await {
        Ok(handle) => handle,
        Err(error) if is_missing(&error) => return Ok(ReadTranscript::Gone),
        Err(_) => return Ok(ReadTranscript::Unreadable),
    };
    let read = async {
        if file.path.ends_with(COMPRESSED_SUFFIX) {
            let source = BufReader::with_capacity(READ_CHUNK_BYTES, &mut handle);
            let mut decompressed = ZstdDecoder::new(source);
            decompressed.multiple_members(true);
            let parsed = parse_lines(
                format,
                decompressed,
                0,
                format.create_state(),
                steps,
                signal,
            )
            .await?;
            return Ok::<_, Box<dyn std::error::Error>>(ReadTranscript::Read {
                parsed,
                resume: false,
                guard_hash: 0,
            });
        }
        let base = if let Some(cached) = cached
            && file.size > cached.size
            && guard_matches(&mut handle, cached.resume_offset, cached.guard_hash).await
        {
            Some(cached)
        } else {
            None
        };
        let start = base.map_or(0, |cached| cached.resume_offset);
        let state = base.map_or_else(
            || format.create_state(),
            |cached| format.clone_state(&cached.state),
        );
        handle.seek(SeekFrom::Start(start)).await?;
        let parsed = parse_lines(
            format,
            (&mut handle).take(file.size.saturating_sub(start)),
            start,
            state,
            steps,
            signal,
        )
        .await?;
        let guard_hash = read_guard_hash(&mut handle, parsed.resume_offset).await?;
        Ok(ReadTranscript::Read {
            parsed,
            resume: base.is_some(),
            guard_hash,
        })
    }
    .await;
    match read {
        Ok(read) => Ok(read),
        Err(_) => {
            check_abort(signal)?;
            Ok(ReadTranscript::Unreadable)
        }
    }
}

async fn parse_lines<F: TranscriptUsageFormat>(
    format: &F,
    mut source: impl AsyncRead + Unpin,
    offset: u64,
    mut state: F::State,
    steps: &mut EventLoopSteps,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<ParsedLines<F::State>> {
    let markers: Vec<_> = format
        .line_markers()
        .iter()
        .map(|marker| Finder::new(*marker))
        .collect();
    let has_marker = |bytes: &[u8]| markers.iter().any(|finder| finder.find(bytes).is_some());
    let parse = |bytes: &[u8], state: &mut F::State| {
        if !has_marker(bytes) {
            return Ok(None);
        }
        let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
        format.parse_line(&String::from_utf8_lossy(bytes), state)
    };
    let mut records = Vec::new();
    let mut malformed = Vec::new();
    let mut pending = Vec::new();
    let mut pending_has_marker = false;
    let mut oversized = false;
    let mut oversized_has_marker = false;
    let mut position = offset;
    let mut resume_offset = offset;
    let mut buffer = vec![0; READ_CHUNK_BYTES];
    loop {
        let count = source.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        check_abort(signal)?;
        let chunk = &buffer[..count];
        let mut line_start = 0;
        while line_start < count {
            let newline = memchr(b'\n', &chunk[line_start..]).map(|relative| line_start + relative);
            let piece = &chunk[line_start..newline.unwrap_or(count)];
            if oversized || pending.len() + piece.len() > MAX_LINE_BYTES {
                if !oversized {
                    oversized_has_marker = pending_has_marker;
                }
                oversized = true;
                oversized_has_marker |= has_marker(piece);
                pending.clear();
            } else if !piece.is_empty() {
                if newline.is_none() {
                    pending_has_marker |= has_marker(piece);
                }
                pending.extend_from_slice(piece);
            }
            let Some(newline) = newline else {
                break;
            };
            if oversized {
                if oversized_has_marker {
                    malformed.push(MalformedUsage { timestamp_ms: None });
                }
            } else if let Some(line) = parse(&pending, &mut state)? {
                match line {
                    UsageLine::Record(record) => records.push(record),
                    UsageLine::Malformed(record) => malformed.push(record),
                }
            }
            pending.clear();
            pending_has_marker = false;
            oversized = false;
            oversized_has_marker = false;
            line_start = newline + 1;
            resume_offset = position + line_start as u64;
            if steps.due() {
                steps.next().await;
                check_abort(signal)?;
            }
        }
        position += count as u64;
    }
    let committed_state = format.clone_state(&state);
    let tail_records = if !oversized
        && !pending.is_empty()
        && let Some(UsageLine::Record(record)) = parse(&pending, &mut state)?
    {
        vec![record]
    } else {
        Vec::new()
    };
    Ok(ParsedLines {
        records,
        malformed,
        tail_records,
        resume_offset,
        state: committed_state,
    })
}

async fn merge_records<State>(
    base: Option<CachedTranscript<State>>,
    parsed: ParsedLines<State>,
    file: &TranscriptFile,
    guard_hash: u32,
    retained_since_ms: i64,
    steps: &mut EventLoopSteps,
) -> CachedTranscript<State> {
    let ParsedLines {
        records,
        malformed,
        tail_records,
        resume_offset,
        state,
    } = parsed;
    let (mut target, mut key_index, mut oldest_ms) = base.map_or_else(
        || (ScannedTranscript::default(), HashMap::new(), i64::MAX),
        |base| (base.records, base.key_index, base.oldest_ms),
    );
    oldest_ms = oldest_ms.min(
        retain_into(
            &mut target,
            &mut key_index,
            records,
            malformed,
            retained_since_ms,
            steps,
        )
        .await,
    );
    if oldest_ms < retained_since_ms {
        let previous = std::mem::take(&mut target);
        key_index.clear();
        oldest_ms = retain_into(
            &mut target,
            &mut key_index,
            previous.records,
            previous.malformed,
            retained_since_ms,
            steps,
        )
        .await;
    }
    target.tail_records = new_tail_records(tail_records, &key_index, retained_since_ms);
    CachedTranscript {
        size: file.size,
        mtime_ms: file.mtime_ms,
        records: target,
        key_index,
        oldest_ms,
        resume_offset,
        guard_hash,
        state,
    }
}

fn append_record(
    records: &mut Vec<UsageRecord>,
    key_index: &mut HashMap<String, usize>,
    record: UsageRecord,
) {
    if let Some(key) = &record.dedupe_key {
        if let Some(&index) = key_index.get(key) {
            records[index] = merge_usage_copies(&records[index], &record);
            return;
        }
        key_index.insert(key.clone(), records.len());
    }
    records.push(record);
}

fn new_tail_records(
    tail: Vec<UsageRecord>,
    key_index: &HashMap<String, usize>,
    retained_since_ms: i64,
) -> Vec<UsageRecord> {
    let mut records = Vec::new();
    let mut tail_index = HashMap::new();
    for record in tail {
        if record.timestamp_ms < retained_since_ms
            || record
                .dedupe_key
                .as_ref()
                .is_some_and(|key| key_index.contains_key(key))
        {
            continue;
        }
        append_record(&mut records, &mut tail_index, record);
    }
    records
}

async fn retain_into(
    target: &mut ScannedTranscript,
    key_index: &mut HashMap<String, usize>,
    records: Vec<UsageRecord>,
    malformed: Vec<MalformedUsage>,
    retained_since_ms: i64,
    steps: &mut EventLoopSteps,
) -> i64 {
    let mut oldest_ms = i64::MAX;
    steps
        .for_each(records, |record| {
            if record.timestamp_ms < retained_since_ms {
                return;
            }
            oldest_ms = oldest_ms.min(record.timestamp_ms);
            append_record(&mut target.records, key_index, record);
        })
        .await;
    for entry in malformed {
        if let Some(time) = entry.timestamp_ms {
            if time < retained_since_ms {
                continue;
            }
            oldest_ms = oldest_ms.min(time);
        }
        target.malformed.push(entry);
    }
    oldest_ms
}

struct TranscriptListing {
    root_found: bool,
    files: Vec<TranscriptFile>,
    unstatable_paths: Vec<String>,
    unreadable_paths: u64,
}

async fn list_transcripts(
    roots: Vec<String>,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<TranscriptListing> {
    let mut candidates = HashSet::new();
    let mut listing = TranscriptListing {
        root_found: false,
        files: Vec::new(),
        unstatable_paths: Vec::new(),
        unreadable_paths: 0,
    };
    let cwd = std::env::current_dir()?.to_string_lossy().into_owned();
    let roots: IndexSet<_> = roots
        .iter()
        .map(|root| garcon_js::path::native::resolve(&cwd, &[root]))
        .collect();
    for root in roots {
        walk(&root, 0, &mut candidates, &mut listing, signal).await?;
    }
    let mut paths: Vec<_> = candidates
        .iter()
        .filter(|candidate| {
            !candidate.ends_with(COMPRESSED_SUFFIX)
                || !candidate
                    .strip_suffix(".zst")
                    .is_some_and(|path| candidates.contains(path))
        })
        .collect();
    paths.sort_by(|a, b| utf16::cmp(a, b));
    let mut stats = stream::iter(
        paths
            .into_iter()
            .map(|path| async move { (path, stat_transcript(path).await) }),
    )
    .buffered(STAT_CONCURRENCY);
    while let Some((path, result)) = stats.next().await {
        match result {
            Ok(file) => listing.files.push(file),
            Err(error) if is_missing(&error) => {}
            Err(_) => {
                listing.unreadable_paths += 1;
                listing.unstatable_paths.push(path.clone());
            }
        }
    }
    Ok(listing)
}

async fn walk(
    directory: &str,
    depth: usize,
    candidates: &mut HashSet<String>,
    listing: &mut TranscriptListing,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<()> {
    check_abort(signal)?;
    let entries = async {
        let mut entries = fs::read_dir(directory).await?;
        let mut results = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            results.push((
                entry.path().to_string_lossy().into_owned(),
                entry.file_type().await?,
            ));
        }
        Ok::<_, io::Error>(results)
    }
    .await;
    let entries = match entries {
        Ok(entries) => entries,
        Err(error) if depth == 0 && is_missing(&error) => return Ok(()),
        Err(_) => {
            if depth == 0 {
                listing.root_found = true;
            }
            listing.unreadable_paths += 1;
            return Ok(());
        }
    };
    if depth == 0 {
        listing.root_found = true;
    }
    for (path, file_type) in entries {
        if file_type.is_dir() {
            if depth < MAX_DIRECTORY_DEPTH {
                Box::pin(walk(&path, depth + 1, candidates, listing, signal)).await?;
            }
        } else if file_type.is_file()
            && (path.ends_with(PLAIN_SUFFIX) || path.ends_with(COMPRESSED_SUFFIX))
        {
            candidates.insert(path);
        }
    }
    Ok(())
}

async fn stat_transcript(path: &str) -> io::Result<TranscriptFile> {
    let stat = fs::metadata(path).await?;
    let time = stat.modified()?;
    let duration_ms = |duration: std::time::Duration| {
        duration.as_secs() as f64 * 1000.0 + f64::from(duration.subsec_nanos()) / 1e6
    };
    let mtime_ms = time
        .duration_since(UNIX_EPOCH)
        .map_or_else(|before| -duration_ms(before.duration()), duration_ms);
    Ok(TranscriptFile {
        path: path.to_owned(),
        size: stat.len(),
        mtime_ms,
    })
}

fn is_missing(error: &io::Error) -> bool {
    has_node_error_code(ErrorInput::Error(error), "ENOENT")
}

pub(super) fn check_abort(signal: Option<&CancellationToken>) -> ExecutorResult<()> {
    if signal.is_some_and(CancellationToken::is_cancelled) {
        Err(Box::new(LockAborted))
    } else {
        Ok(())
    }
}

async fn read_guard_hash(handle: &mut File, resume_offset: u64) -> io::Result<u32> {
    let length = resume_offset.min(GUARD_BYTES as u64) as usize;
    if length == 0 {
        return Ok(0);
    }
    handle
        .seek(SeekFrom::Start(resume_offset - length as u64))
        .await?;
    let mut window = [0; GUARD_BYTES];
    let bytes = handle.read(&mut window[..length]).await?;
    Ok(window[..bytes].iter().fold(0x811c9dc5u32, |hash, &byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x01000193)
    }))
}

async fn guard_matches(handle: &mut File, resume_offset: u64, guard_hash: u32) -> bool {
    resume_offset > 0
        && read_guard_hash(handle, resume_offset)
            .await
            .is_ok_and(|hash| hash == guard_hash)
}
