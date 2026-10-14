export const PULL_REQUEST_REVIEW_SCHEMA_V1 = [
`CREATE TABLE review_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL
) STRICT`,
`CREATE TABLE review_repositories (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  scan_json TEXT NOT NULL,
  pulls_json TEXT NOT NULL
) STRICT`,
`CREATE TABLE review_runs (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL REFERENCES review_repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','reviewing','needs-input','completed','outdated','failed','stopped','interrupted')),
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  review TEXT
) STRICT`,
`CREATE INDEX review_runs_pull ON review_runs(repository_id, number, created_at DESC)`,
`CREATE INDEX review_runs_recent ON review_runs(created_at DESC)`,
`CREATE INDEX review_runs_state ON review_runs(state)`,
`PRAGMA user_version = 1`,
] as const;
