# Usage

The Usage surface reports token usage and estimated API cost per executor, for
7, 30, or 90 calendar days in the viewer's time zone. Executors keep 92 days of
usage, so windows that start earlier are rejected. It reads the native
Claude and Codex transcripts on that executor, so it includes sessions Garcon
did not start. Open it from the sidebar menu, a window's add menu, or the
command palette.

## Data Flow

```text
Usage surface -> GET /api/v1/usage?executorId&sinceDay&untilDay&timeZone
  -> UsageService (controller): one usageHistory.read per integration, merged
    -> AgentIntegration.usageHistory on the executor (Local or remote)
      -> TranscriptUsageScanner + UsageAggregator (server-agents/common/src/usage)
```

- `usageHistory` is a nullable `AgentIntegration` facet. Claude reads
  `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`), including
  subagent transcripts. Codex reads `$CODEX_HOME/sessions` and
  `$CODEX_HOME/archived_sessions` (default `~/.codex`), including rollouts
  Codex compressed to `.jsonl.zst`, which are decompressed as a stream; while both
  forms of one rollout exist, the plain file is read, and a file moved away
  mid-scan is read where it now lives. Other integrations report no usage facet.
- Transcripts are parsed on the executor that owns them. A remote executor
  answers over the bulk lane with day-by-model buckets, not raw records; the
  controller validates the report and never reads worker paths itself.
- The controller validates every integration report, Local or remote. A failed,
  invalid, or timed-out read becomes a `failed` agent entry, so one provider
  cannot hide another's usage, and the surface shows the failure rather than an
  empty period. The controller stops waiting at its deadline even if a read has
  not yet observed its signal. An unavailable executor fails the request with
  `EXECUTOR_UNAVAILABLE`; the surface keeps that executor selected and never
  falls back to Local.
- A transcript root that is absent reports `missing`; one that exists but
  cannot be read, and unreadable transcripts, report `partial`. Malformed usage
  lines mark a report `partial` only when they fall inside the window, or when
  their time is unknown.
- Parsed transcripts are cached in memory by size and modification time, and a
  grown file resumes after its last complete line. Each cached file keeps one
  record per request and drops usage older than any selectable window. The
  cache lives as long as the integration; restart rereads every transcript in
  the window.
- One read is one `EventLoopSteps` operation, `claude-usage-history` or
  `codex-usage-history`, shared by scanning and aggregation.

## Counting Rules

- Claude writes one line per assistant content block, each repeating the
  message usage. Lines sharing `message.id:requestId` count once, at their
  earliest timestamp; Claude Code's own resumes copy the same keys. Entries a
  Garcon fork copied carry `forkedFrom` and are skipped, because their requests
  were billed in the source session (the fork also restamps its last copy).
- Codex `token_count` events take their model from the latest `turn_context`
  and their tier from the latest `thread_settings_applied`. Cumulative counters
  reconcile each request delta; inconsistent events are skipped and reported as
  malformed. Garcon's JSONL fork copies events verbatim under a new session id,
  so a request's identity is its event time, model, and counters, and copies
  count once. Codex's native forks restamp the copied history; those copies are
  recognized as the burst of events right after the fork's `session_meta`,
  since legacy rollouts record no explicit boundary
  (`forked_from_ordinal_exclusive` is set only for reverts and paginated
  history).
- Both parsers read the first JSON value of a line that lost its newline, as
  the history loaders do; an unparseable usage line counts as malformed.
- Reasoning tokens are part of output and are never billed twice.
- Cache hit rate is cache reads over all input, so cache writes count as misses.

## Pricing

Costs are API list-price estimates from the built-in table in
`server-agents/common/src/usage/model-prices.ts`, dated by
`USAGE_PRICING_AS_OF`; they are not a bill and do not reflect subscription
plans. Anthropic rates follow the official pricing page, including per-model
cache-read rates, one-hour cache writes, fast mode, and Haiku 5.5's long-prompt
tier. OpenAI rates follow LiteLLM's published table, including priority
processing, flex processing, and the 272K-token long-context tier. Model names are matched after
removing provider prefixes, snapshot dates, and context variants such as
`[1m]`. A model missing from the table is reported as unpriced: its tokens
count, its cost is shown as unknown rather than zero, and totals note the
excluded tokens. Update the table and its date together.
