use std::{
    cell::{Cell, RefCell},
    fs::{self, FileTimes, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    rc::Rc,
    time::{Duration, UNIX_EPOCH},
};

use async_compression::tokio::write::ZstdEncoder;
use garcon_agents_common::usage::{
    transcript_usage_scanner::{
        TranscriptUsageScan, TranscriptUsageScanner, TranscriptUsageScannerOptions,
    },
    usage_record::{
        MalformedUsage, NativeUsageTokenTotals, TranscriptUsageFormat, UsageLine, UsageRecord,
        UsageSpeed, parse_timestamp_ms,
    },
};
use garcon_base::{event_loop::EventLoopSteps, keyed_lock::LockAborted};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{
    Number,
    clock::ManualClock,
    date_parse::date_parse,
    json::{as_number, from_str},
};
use serde_json::Value;
use tempfile::{TempDir, tempdir};
use tokio::{io::AsyncWriteExt, task::LocalSet};
use tokio_util::sync::CancellationToken;

type ParseObserver = Rc<dyn Fn(usize)>;

#[derive(Default)]
struct CountingFormat {
    parsed: Rc<RefCell<Vec<String>>>,
    observe: Option<ParseObserver>,
}

impl TranscriptUsageFormat for CountingFormat {
    type State = String;

    fn line_markers(&self) -> &[&str] {
        &["\"usage\"", "\"model\""]
    }
    fn create_state(&self) -> String {
        String::new()
    }
    fn clone_state(&self, state: &String) -> String {
        state.clone()
    }

    fn parse_line(&self, line: &str, state: &mut String) -> ExecutorResult<Option<UsageLine>> {
        if let Some(observe) = &self.observe {
            observe(self.parsed.borrow().len());
        }
        self.parsed.borrow_mut().push(line.to_owned());
        let entry: Value = from_str(line)?;
        let timestamp = entry
            .get("at")
            .map_or_else(|| date_parse("2026-10-10T00:00:00Z"), parse_timestamp_ms);
        if let Some(model) = entry["model"].as_str().filter(|name| !name.is_empty()) {
            *state = model.to_owned();
            return Ok(None);
        }
        let Some(usage) = as_number(&entry["usage"]).filter(|&usage| usage >= 0.0) else {
            return Ok(Some(UsageLine::Malformed(MalformedUsage {
                timestamp_ms: timestamp,
            })));
        };
        Ok(Some(UsageLine::Record(UsageRecord {
            timestamp_ms: timestamp.unwrap(),
            model: state.clone(),
            session_id: "session".into(),
            totals: NativeUsageTokenTotals {
                uncached_input_tokens: Number(usage),
                cached_input_tokens: Number(0.0),
                cache_write_tokens: Number(0.0),
                output_tokens: Number(0.0),
                reasoning_tokens: Number(0.0),
            },
            cache_write_1h_tokens: Number(0.0),
            speed: UsageSpeed::Standard,
            dedupe_key: entry["id"].as_str().map(str::to_owned),
        })))
    }
}

struct Fixture {
    root: TempDir,
    parsed: Rc<RefCell<Vec<String>>>,
    clock: Rc<ManualClock>,
}

impl Fixture {
    fn new() -> Self {
        Self {
            root: tempdir().unwrap(),
            parsed: Rc::default(),
            clock: Rc::new(ManualClock::new(
                date_parse("2026-10-27T00:00:00Z").unwrap(),
            )),
        }
    }

    fn path(&self, file: &str) -> PathBuf {
        self.root.path().join(file)
    }

    fn scanner(
        &self,
        roots: Vec<PathBuf>,
        observe: Option<ParseObserver>,
    ) -> TranscriptUsageScanner<CountingFormat> {
        TranscriptUsageScanner::new(TranscriptUsageScannerOptions {
            operation: "usage-test".into(),
            format: CountingFormat {
                parsed: self.parsed.clone(),
                observe,
            },
            roots: Rc::new(move || {
                Ok(roots
                    .iter()
                    .map(|root| root.to_str().unwrap().to_owned())
                    .collect())
            }),
            clock: Some(self.clock.clone()),
        })
    }

    fn default_scanner(&self) -> TranscriptUsageScanner<CountingFormat> {
        self.scanner(vec![self.root.path().into()], None)
    }

    fn write(&self, file: &str, content: &str) {
        let path = self.path(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn append(&self, file: &str, content: &str) {
        OpenOptions::new()
            .append(true)
            .open(self.path(file))
            .unwrap()
            .write_all(content.as_bytes())
            .unwrap();
    }
}

async fn scan(scanner: &mut TranscriptUsageScanner<CountingFormat>) -> TranscriptUsageScan<'_> {
    scanner
        .scan(0, &mut EventLoopSteps::new("usage-test"), None)
        .await
        .unwrap()
}

fn usage(scan: TranscriptUsageScan<'_>) -> Vec<String> {
    scan.files
        .iter()
        .flat_map(|file| file.records.iter().chain(&file.tail_records))
        .map(|row| format!("{}:{}", row.model, row.totals.uncached_input_tokens))
        .collect()
}

#[tokio::test]
async fn reports_missing_roots_and_walks_nested_transcripts_only_once() {
    let fixture = Fixture::new();
    let mut scanner = fixture.scanner(vec![fixture.path("missing")], None);
    let missing = scan(&mut scanner).await;
    assert!(!missing.root_found && missing.files.is_empty());
    assert_eq!(missing.unreadable_paths, 0);

    fixture.write(
        "project/a.jsonl",
        "{\"model\":\"m1\"}\r\n{\"text\":\"no marker\"}\r\n{\"usage\":5}\r\n",
    );
    fixture.write(
        "project/session/subagents/agent.jsonl",
        "{\"model\":\"m2\"}\n{\"usage\":7}\n",
    );
    fixture.write("project/notes.txt", "{\"usage\":99}\n");
    #[cfg(unix)]
    std::os::unix::fs::symlink(fixture.path("project"), fixture.path("alias")).unwrap();
    let mut scanner = fixture.scanner(
        vec![fixture.root.path().into(), fixture.path("project")],
        None,
    );
    let result = scan(&mut scanner).await;
    assert!(result.root_found);
    assert_eq!(usage(result), ["m1:5", "m2:7"]);
    assert_eq!(fixture.parsed.borrow().len(), 4);
}

async fn write_compressed(file: &Path, content: &[u8]) {
    let output = tokio::fs::File::create(file).await.unwrap();
    let mut writer = ZstdEncoder::new(output);
    writer.write_all(content).await.unwrap();
    writer.shutdown().await.unwrap();
}

#[tokio::test]
async fn reads_compressed_rollouts_and_prefers_a_plain_copy_while_both_exist() {
    let fixture = Fixture::new();
    write_compressed(
        &fixture.path("cold.jsonl.zst"),
        b"{\"model\":\"m1\"}\n{\"usage\":3}\n",
    )
    .await;
    fixture.write("moving.jsonl", "{\"model\":\"m2\"}\n{\"usage\":4}\n");
    write_compressed(
        &fixture.path("moving.jsonl.zst"),
        b"{\"model\":\"m2\"}\n{\"usage\":99}\n",
    )
    .await;
    let mut scanner = fixture.default_scanner();
    assert_eq!(usage(scan(&mut scanner).await), ["m1:3", "m2:4"]);
    fs::remove_file(fixture.path("moving.jsonl")).unwrap();
    assert_eq!(usage(scan(&mut scanner).await), ["m1:3", "m2:99"]);
}

#[tokio::test]
async fn resumes_from_the_last_complete_line_with_context_and_merges_duplicates() {
    let fixture = Fixture::new();
    fixture.write(
        "a.jsonl",
        "{\"model\":\"m1\"}\n{\"usage\":5,\"id\":\"a\"}\n{\"usage\":5,\"id\":\"a\"}",
    );
    let mut scanner = fixture.default_scanner();
    assert_eq!(usage(scan(&mut scanner).await), ["m1:5"]);
    fixture.parsed.borrow_mut().clear();
    fixture.append(
        "a.jsonl",
        "\n{\"usage\":6,\"id\":\"a\"}\n{\"usage\":2,\"id\":\"b\"}",
    );
    assert_eq!(usage(scan(&mut scanner).await), ["m1:6", "m1:2"]);
    assert_eq!(
        *fixture.parsed.borrow(),
        [
            "{\"usage\":5,\"id\":\"a\"}",
            "{\"usage\":6,\"id\":\"a\"}",
            "{\"usage\":2,\"id\":\"b\"}",
        ]
    );
    fixture.parsed.borrow_mut().clear();
    assert_eq!(usage(scan(&mut scanner).await), ["m1:6", "m1:2"]);
    assert!(fixture.parsed.borrow().is_empty());
    fixture.append("a.jsonl", "\n{\"usage\":4}\n");
    assert_eq!(usage(scan(&mut scanner).await), ["m1:6", "m1:2", "m1:4"]);
}

#[tokio::test]
async fn reparses_grown_rewrites_and_truncated_files() {
    let fixture = Fixture::new();
    fixture.write("a.jsonl", "{\"model\":\"m1\"}\n{\"usage\":1}\n");
    let mut scanner = fixture.default_scanner();
    assert_eq!(usage(scan(&mut scanner).await), ["m1:1"]);
    fixture.write(
        "a.jsonl",
        "{\"model\":\"m9\"}\n{\"usage\":10}\n{\"usage\":20}\n",
    );
    assert_eq!(usage(scan(&mut scanner).await), ["m9:10", "m9:20"]);
    fixture.write("a.jsonl", "{\"model\":\"m3\"}\n{\"usage\":3}\n");
    assert_eq!(usage(scan(&mut scanner).await), ["m3:3"]);
}

#[tokio::test]
async fn applies_scan_window_and_retention_and_forgets_deleted_files() {
    let fixture = Fixture::new();
    fixture.write("a.jsonl", "{\"model\":\"m1\"}\n{\"usage\":1}\n");
    fixture.write("b.jsonl", "{\"model\":\"m2\"}\n{\"usage\":4,\"at\":\"2026-06-01\"}\n{\"usage\":1,\"at\":\"2026-08-01\"}\n{\"usage\":2}\n");
    let earlier = UNIX_EPOCH + Duration::from_millis(date_parse("2026-09-01").unwrap() as u64);
    OpenOptions::new()
        .write(true)
        .open(fixture.path("a.jsonl"))
        .unwrap()
        .set_times(FileTimes::new().set_modified(earlier))
        .unwrap();
    let mut scanner = fixture.default_scanner();
    let since = date_parse("2026-10-01").unwrap();
    let since = scanner
        .scan(since, &mut EventLoopSteps::new("usage-test"), None)
        .await
        .unwrap();
    assert_eq!(usage(since), ["m2:1", "m2:2"]);
    fixture.clock.advance(30 * 86_400_000);
    fixture.append("b.jsonl", "{\"usage\":3,\"at\":\"2026-11-20\"}\n");
    assert_eq!(usage(scan(&mut scanner).await), ["m1:1", "m2:2", "m2:3"]);
    fs::remove_file(fixture.path("b.jsonl")).unwrap();
    assert_eq!(usage(scan(&mut scanner).await), ["m1:1"]);
}

#[tokio::test]
async fn keeps_timed_malformed_usage_and_skips_only_usage_bearing_oversized_lines() {
    let fixture = Fixture::new();
    let mut file = fs::File::create(fixture.path("a.jsonl")).unwrap();
    file.write_all(b"{\"model\":\"m1\"}\n{\"usage\":-1,\"at\":\"2026-10-20\"}\n")
        .unwrap();
    let pad = vec![b'x'; 256 * 1024];
    for marker in [b"\"usage\"".as_slice(), b"irrelevant"] {
        file.write_all(marker).unwrap();
        for _ in 0..128 {
            file.write_all(&pad).unwrap();
        }
        file.write_all(b"\n").unwrap();
    }
    file.write_all(b"{\"usage\":6}\n{\"usage\":-1}").unwrap();
    drop(file);
    let mut scanner = fixture.default_scanner();
    let output = scan(&mut scanner).await;
    assert_eq!(
        output.files[0]
            .malformed
            .iter()
            .map(|line| line.timestamp_ms)
            .collect::<Vec<_>>(),
        [date_parse("2026-10-20"), None]
    );
    assert_eq!(usage(output), ["m1:6"]);
}

#[tokio::test]
async fn cancels_a_resumed_file_without_committing_its_partial_progress() {
    let fixture = Fixture::new();
    fixture.write("resume.jsonl", "{\"model\":\"m1\"}\n{\"usage\":1}\n");
    let signal = CancellationToken::new();
    let mut scanner = fixture.scanner(
        vec![fixture.root.path().into()],
        Some(Rc::new({
            let signal = signal.clone();
            move |parsed| {
                if parsed == 100 {
                    signal.cancel();
                }
            }
        })),
    );
    assert_eq!(usage(scan(&mut scanner).await), ["m1:1"]);
    let line = format!("{{\"usage\":1,\"pad\":\"{}\"}}\n", "x".repeat(96));
    fixture.append("resume.jsonl", &line.repeat(20_000));
    let aborted = scanner
        .scan(0, &mut EventLoopSteps::new("usage-test"), Some(&signal))
        .await;
    assert!(matches!(aborted, Err(ref error) if error.is::<LockAborted>()));
    assert!(fixture.parsed.borrow().len() < 10_000);
    let rejected = scanner
        .scan(0, &mut EventLoopSteps::new("usage-test"), Some(&signal))
        .await;
    assert!(matches!(rejected, Err(ref error) if error.is::<LockAborted>()));
    assert_eq!(scan(&mut scanner).await.files[0].records.len(), 20_001);
}

#[tokio::test]
async fn yields_between_large_batches_and_reuses_cached_records_on_resume() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            fixture.write("large.jsonl", "{\"model\":\"m1\"}\n");
            let line = format!("{{\"usage\":1,\"pad\":\"{}\"}}\n", "x".repeat(96));
            fixture.append("large.jsonl", &line.repeat(40_000));
            let clock = Rc::new(Cell::new(0));
            let witnessed = Rc::new(Cell::new(false));
            let mut scanner = fixture.scanner(
                vec![fixture.root.path().into()],
                Some(Rc::new({
                    let clock = clock.clone();
                    move |count| clock.set(count)
                })),
            );
            let monitor = tokio::task::spawn_local({
                let clock = clock.clone();
                let witnessed = witnessed.clone();
                async move {
                    while clock.get() < 40_000 {
                        if clock.get() > 0 {
                            witnessed.set(true);
                        }
                        tokio::time::sleep(Duration::from_millis(1)).await;
                    }
                }
            });
            let mut steps = EventLoopSteps::with_clock("usage-test", {
                let clock = clock.clone();
                move || (clock.get() / 100) as f64
            });
            let result = scanner.scan(0, &mut steps, None).await.unwrap();
            assert_eq!(result.files[0].records.len(), 40_000);
            assert!(witnessed.get());
            monitor.await.unwrap();
            fixture.parsed.borrow_mut().clear();
            fixture.append("large.jsonl", "{\"usage\":2}\n");
            assert_eq!(scan(&mut scanner).await.files[0].records.len(), 40_001);
            assert_eq!(fixture.parsed.borrow().len(), 1);
        })
        .await;
}

#[tokio::test]
async fn reports_a_transcript_moved_away_after_listing_as_unreadable() {
    let fixture = Fixture::new();
    fixture.write("a.jsonl", "{\"model\":\"m1\"}\n{\"usage\":1}\n");
    fixture.write("b.jsonl", "{\"model\":\"m2\"}\n{\"usage\":2}\n");
    let mut scanner = fixture.scanner(
        vec![fixture.root.path().into()],
        Some(Rc::new({
            let source = fixture.path("b.jsonl");
            let destination = fixture.path("elsewhere.txt");
            move |parsed| {
                if parsed == 0 {
                    fs::rename(&source, &destination).unwrap();
                }
            }
        })),
    );
    let result = scan(&mut scanner).await;
    assert_eq!(result.unreadable_paths, 1);
    assert_eq!(usage(result), ["m1:1"]);
}

#[cfg(unix)]
#[tokio::test]
async fn reports_an_unreadable_root_and_keeps_the_last_parse_of_an_unstatable_file() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.write("project/a.jsonl", "{\"model\":\"m1\"}\n{\"usage\":4}\n");
    let mut scanner = fixture.default_scanner();
    assert_eq!(usage(scan(&mut scanner).await), ["m1:4"]);
    let project = fixture.path("project");
    let mode =
        |path: &Path, mode| fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    mode(&project, 0o644);
    let result = scan(&mut scanner).await;
    mode(&project, 0o755);
    assert_eq!(result.unreadable_paths, 1);
    assert_eq!(usage(result), ["m1:4"]);
    mode(fixture.root.path(), 0o000);
    let result = scan(&mut scanner).await;
    mode(fixture.root.path(), 0o755);
    assert!(result.root_found && result.files.is_empty());
    assert_eq!(result.unreadable_paths, 1);
}
