export type GitReviewRoutePhaseName =
  | 'resolve' | 'summary-git' | 'document-register' | 'freshness-before'
  | 'body-cache' | 'body-git' | 'body-split' | 'patch-scan' | 'freshness-after' | 'serialize';

export interface GitReviewRoutePhase {
  name: GitReviewRoutePhaseName;
  durationMs: number;
}

export interface GitReviewRouteMetrics {
  phases: GitReviewRoutePhase[];
  fileCount?: number;
  rowCount?: number;
  cacheHits?: number;
  batchCount?: number;
  bisectionCount?: number;
}

export interface GitOperationDiagnostics extends GitReviewRouteMetrics {
  commands: { command: string; durationMs: number; stdoutBytes: number; stderrBytes: number }[];
}
