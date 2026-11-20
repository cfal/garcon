// Contract for checking and updating a provider's native CLI on one executor.

import { isRecord } from './json.js';

export const AGENT_CLI_INSTALL_METHODS = [
  'bundled', 'native', 'npm', 'bun', 'pnpm', 'yarn', 'homebrew', 'unmanaged', 'missing',
] as const;
export type AgentCliInstallMethod = typeof AGENT_CLI_INSTALL_METHODS[number];

export const AGENT_CLI_VERSION_ADVISORIES = ['unknown', 'current', 'behind-latest'] as const;
export type AgentCliVersionAdvisory = typeof AGENT_CLI_VERSION_ADVISORIES[number];

export const AGENT_CLI_UPDATE_RUN_STATES = ['idle', 'running', 'succeeded', 'failed', 'unchanged'] as const;
export type AgentCliUpdateRunState = typeof AGENT_CLI_UPDATE_RUN_STATES[number];

export const AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS = 10_000;
// Bounds run messages and per-agent failures that executors and the controller report.
export const AGENT_CLI_UPDATE_MESSAGE_MAX_CHARS = 500;
const MAX_TEXT_CHARS = 4_096;

// The most recent update run on this executor. `message` is the latest
// progress line while running and the outcome afterwards.
export interface AgentCliUpdateRun {
  readonly state: AgentCliUpdateRunState;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output: string | null;
}

export interface AgentCliUpdateStatus {
  // The CLI's product name, such as "Claude Code".
  readonly cliLabel: string;
  readonly installMethod: AgentCliInstallMethod;
  // Real path of the CLI that Garcon runs, after following symlinks.
  readonly installPath: string | null;
  readonly currentVersion: string | null;
  readonly latestVersion: string | null;
  readonly advisory: AgentCliVersionAdvisory;
  // The command Garcon runs when `canUpdate`, otherwise one the user can run.
  readonly updateCommand: string | null;
  readonly canUpdate: boolean;
  readonly message: string | null;
  readonly checkedAt: string;
  readonly run: AgentCliUpdateRun;
}

// GET /api/v1/agents/cli-updates: every agent on the executor that can report
// its CLI. An agent whose check failed appears only in `failures`.
export interface AgentCliUpdatesResponse {
  readonly statuses: Readonly<Record<string, AgentCliUpdateStatus>>;
  readonly failures: Readonly<Record<string, string>>;
}

// POST /api/v1/agents/cli-updates answers with the agent's AgentCliUpdateStatus.
export interface AgentCliUpdateRequest {
  readonly agentId: string;
  readonly executorId?: string;
}

export const IDLE_AGENT_CLI_UPDATE_RUN: AgentCliUpdateRun = Object.freeze({
  state: 'idle', startedAt: null, finishedAt: null, message: null, output: null,
});

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isNullableText(value: unknown, maxChars = MAX_TEXT_CHARS): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maxChars);
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function parseAgentCliUpdateRun(value: unknown): AgentCliUpdateRun | null {
  if (!isRecord(value)) return null;
  const { state, startedAt, finishedAt, message, output } = value;
  if (!isOneOf(AGENT_CLI_UPDATE_RUN_STATES, state)) return null;
  if (!isNullableTimestamp(startedAt) || !isNullableTimestamp(finishedAt)) return null;
  if (!isNullableText(message) || !isNullableText(output, AGENT_CLI_UPDATE_OUTPUT_MAX_CHARS)) return null;
  return { state, startedAt, finishedAt, message, output };
}

export function parseAgentCliUpdateStatus(value: unknown): AgentCliUpdateStatus | null {
  if (!isRecord(value)) return null;
  const {
    cliLabel, installMethod, installPath, currentVersion, latestVersion, advisory,
    updateCommand, canUpdate, message, checkedAt,
  } = value;
  if (typeof cliLabel !== 'string' || cliLabel.length === 0 || cliLabel.length > 64) return null;
  if (!isOneOf(AGENT_CLI_INSTALL_METHODS, installMethod)) return null;
  if (!isOneOf(AGENT_CLI_VERSION_ADVISORIES, advisory)) return null;
  if (!isNullableText(installPath) || !isNullableText(currentVersion) || !isNullableText(latestVersion)) return null;
  if (!isNullableText(updateCommand) || !isNullableText(message)) return null;
  if (typeof canUpdate !== 'boolean' || !isTimestamp(checkedAt)) return null;
  const run = parseAgentCliUpdateRun(value.run);
  if (!run) return null;
  return {
    cliLabel, installMethod, installPath, currentVersion, latestVersion, advisory,
    updateCommand, canUpdate, message, checkedAt, run,
  };
}

export function parseAgentCliUpdatesResponse(value: unknown): AgentCliUpdatesResponse | null {
  if (!isRecord(value) || !isRecord(value.statuses) || !isRecord(value.failures)) return null;
  const statuses: Record<string, AgentCliUpdateStatus> = {};
  for (const [agentId, entry] of Object.entries(value.statuses)) {
    const status = parseAgentCliUpdateStatus(entry);
    if (!status) return null;
    statuses[agentId] = status;
  }
  const failures: Record<string, string> = {};
  for (const [agentId, message] of Object.entries(value.failures)) {
    if (typeof message !== 'string' || message.length > MAX_TEXT_CHARS) return null;
    failures[agentId] = message;
  }
  return { statuses, failures };
}
