import type { ExecutionBackend } from './execution-backend.js';

// New server suites join all three lanes unless an explicit exception is recorded here.
export const SINGLE_RUN_SUITES: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries([
    'api-provider-assignments', 'cross-executor-handoff', 'execution-worker-process', 'executor-app',
    'executor-cli-response-limits', 'executor-cli', 'executor-config-updates',
    'executor-delete-cleanup', 'executor-files', 'executor-generation-settings',
    'executor-gh', 'executor-git-admission', 'executor-git-cancellation',
    'executor-git-generation', 'executor-git-normalization', 'executor-git-output-limits',
    'executor-git-prefetch-cancellation', 'executor-git-shared-channel',
    'executor-git-symlinks', 'executor-git', 'executor-history-cancellation',
    'executor-isolation', 'executor-launch-cancellation', 'executor-launch-reconnect', 'executor-path-preferences',
    'executor-permission-reconnect', 'executor-project-base', 'executor-project-cancellation',
    'executor-projects', 'executor-provider-discovery', 'executor-proxy-url', 'executor-queue-reconnect',
    'executor-reference-deletion', 'executor-resource-retention', 'executor-restart', 'executor-rpc-continuity',
    'executor-retained-configuration', 'executor-scheduler-isolation',
    'executor-scripted-permission-reconnect', 'executor-scripted-steer-reconnect',
    'executor-session-setup', 'executor-shutdown',
    'executor-terminal-pressure', 'executor-terminals', 'executor-ticket-defaults',
    'executor-unknown-agent', 'git-input-boundaries', 'lazy-native-compaction',
    'lazy-native-sessions',
  ].map(name => [name, 'Owns its Local/remote fixtures or explicit transport/management matrix.'])),
  ...Object.fromEntries([
    'agent-settings-migration', 'carryover-bootstrap-migration', 'scheduled-prompt-migration',
    'provider-assignment-startup', 'auth-corrupt-state', 'cli-runtime-startup',
  ].map(name => [name, 'Seeds controller storage or tests process discovery/startup directly.'])),
  ...Object.fromEntries([
    'chat-boards', 'chat-canvases', 'chat-canvases-durability', 'chat-reorder', 'chat-sort',
    'tickets', 'websocket-backpressure', 'websocket-payload-limit',
  ].map(name => [name, 'Controller persistence, ordering or browser delivery; no runtime contract under test.'])),
  ...Object.fromEntries([
    'fake-chat-completions-model', 'fixture-auth', 'git-fixture', 'support-contract',
    'persisted-chat-support', 'reload-helper', 'live-claude-protocol-probe',
    'live-codex-protocol-probe', 'live-codex-credential-proxy',
    'garcon-agent-command-reload', 'garcon-schedule-pipeline',
  ].map(name => [name, 'Support-library or injected controller unit contract, not executor dispatch.'])),
  'files-cancellation': 'Owns an HTTP server and a three-way service adapter matrix.',
  'server-suite-inventory': 'Checks lane selection itself.',
});

export function serverSuiteName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1).replace(/\.test\.[jt]s$/, '');
}

export function selectServerSuites(files: readonly string[], backend: ExecutionBackend): string[] {
  return files.filter(file => backend === 'in-process' || !SINGLE_RUN_SUITES[serverSuiteName(file)]).sort();
}
