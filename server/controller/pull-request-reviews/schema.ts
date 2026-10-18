export const PENDING_REVIEW_POST_RECOVERY = `(json_extract(payload_json, '$.post.status') = 'unknown'
  OR (json_extract(payload_json, '$.post.status') = 'posted' AND json_extract(payload_json, '$.post.message') IS NOT NULL))`;

export const PULL_REQUEST_REVIEW_SCHEMA = [
`CREATE TABLE IF NOT EXISTS review_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL
) STRICT`,
`CREATE TABLE IF NOT EXISTS review_repositories (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  scan_json TEXT NOT NULL,
  pulls_json TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  repository_host TEXT NOT NULL,
  repository_name TEXT NOT NULL
) STRICT`,
`CREATE UNIQUE INDEX IF NOT EXISTS review_repositories_identity ON review_repositories(executor_id, repository_host, repository_name)`,
`CREATE TABLE IF NOT EXISTS review_pulls (
  repository_id TEXT NOT NULL REFERENCES review_repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  PRIMARY KEY (repository_id, number)
) STRICT`,
`CREATE INDEX IF NOT EXISTS review_pulls_open ON review_pulls(repository_id, number) WHERE closed_at IS NULL`,
`CREATE INDEX IF NOT EXISTS review_pulls_closed ON review_pulls(repository_id, closed_at, number) WHERE closed_at IS NOT NULL`,
`CREATE TABLE IF NOT EXISTS review_runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES review_repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','reviewing','needs-input','completed','outdated','failed','stopped','interrupted')),
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  review TEXT,
  reviewed_sha TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.reviewedSha')) VIRTUAL,
  trigger TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.trigger')) VIRTUAL,
  chat_id TEXT GENERATED ALWAYS AS (json_extract(payload_json, '$.chatId')) VIRTUAL,
  chat_archived INTEGER GENERATED ALWAYS AS (json_extract(payload_json, '$.chatArchived')) VIRTUAL
) STRICT`,
`CREATE INDEX IF NOT EXISTS review_runs_pull ON review_runs(repository_id, number, created_at)`,
`CREATE INDEX IF NOT EXISTS review_runs_head ON review_runs(repository_id, number, head_sha)`,
`CREATE INDEX IF NOT EXISTS review_runs_reviewed ON review_runs(repository_id, number, reviewed_sha)`,
`CREATE INDEX IF NOT EXISTS review_runs_recent ON review_runs(created_at)`,
`CREATE INDEX IF NOT EXISTS review_runs_state ON review_runs(state)`,
`CREATE INDEX IF NOT EXISTS review_runs_active ON review_runs(repository_id, number) WHERE state IN ('queued','reviewing','needs-input')`,
`CREATE INDEX IF NOT EXISTS review_runs_completed ON review_runs(repository_id, number, reviewed_sha) WHERE state = 'completed'`,
`CREATE INDEX IF NOT EXISTS review_runs_auto ON review_runs(repository_id, json_extract(payload_json, '$.startedAt')) WHERE trigger = 'auto'`,
`CREATE INDEX IF NOT EXISTS review_runs_queued_auto ON review_runs(repository_id) WHERE trigger = 'auto' AND state = 'queued'`,
`CREATE INDEX IF NOT EXISTS review_runs_chat ON review_runs(chat_id) WHERE chat_id IS NOT NULL`,
`CREATE INDEX IF NOT EXISTS review_runs_unknown_post ON review_runs(repository_id) WHERE json_extract(payload_json, '$.post.status') = 'unknown'`,
`CREATE INDEX IF NOT EXISTS review_runs_post_recovery ON review_runs(created_at) WHERE ${PENDING_REVIEW_POST_RECOVERY}`,
`CREATE INDEX IF NOT EXISTS review_runs_archive ON review_runs(repository_id, number)
  WHERE chat_id IS NOT NULL AND chat_archived = 0 AND state NOT IN ('queued','reviewing','needs-input')`,
`CREATE INDEX IF NOT EXISTS review_runs_prunable ON review_runs(repository_id, number)
  WHERE (chat_id IS NULL OR chat_archived = 1) AND state NOT IN ('queued','reviewing','needs-input')
    AND NOT ${PENDING_REVIEW_POST_RECOVERY}`,
...['INSERT', 'UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER IF NOT EXISTS review_runs_revision_${operation.toLowerCase()}
  AFTER ${operation} ON review_runs BEGIN
    UPDATE review_pulls SET revision = revision + 1
      WHERE repository_id = ${operation === 'DELETE' ? 'OLD' : 'NEW'}.repository_id AND number = ${operation === 'DELETE' ? 'OLD' : 'NEW'}.number;
  END`),
] as const;
