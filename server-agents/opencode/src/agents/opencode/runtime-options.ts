import type { AgentLogger } from '@garcon/server-agent-interface';
import type { OpenCodeConfig } from '../../config.js';
import type { OpenCodeInstance } from './instance-lifecycle.js';
import { createOpenCodeInstance } from './server-instance.js';

// Matches OpenCode's own subprocess harness: cold starts of the platform binary are
// dominated by transpile and plugin init, not the listen() call.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/test/lib/cli-process.ts#L363
const DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS = 3_000;
const DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_OPENCODE_UNAVAILABLE_RETRY_MS = 60_000;
const DEFAULT_OPENCODE_SSE_RETRY_DELAY_MS = 3_000;
const DEFAULT_OPENCODE_SSE_HEARTBEAT_TIMEOUT_MS = 30_000;
const DEFAULT_OPENCODE_MODEL_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_OPENCODE_SHUTDOWN_STARTUP_GRACE_MS = 100;
const DEFAULT_OPENCODE_SHUTDOWN_FORK_GRACE_MS = 3_000;

export interface OpenCodeRuntimeOptions {
  config?: OpenCodeConfig;
  logger?: AgentLogger;
  startupTimeoutMs?: number;
  modelDiscoveryTimeoutMs?: number;
  requestTimeoutMs?: number;
  unavailableRetryMs?: number;
  sseRetryDelayMs?: number;
  sseHeartbeatTimeoutMs?: number;
  modelCacheTtlMs?: number;
  shutdownStartupGraceMs?: number;
  shutdownNativeForkGraceMs?: number;
  idleRetirementDelayMs?: number;
  idleRetirementCheckIntervalMs?: number;
  now?: () => number;
  createInstance?: (input: { signal: AbortSignal }) => Promise<OpenCodeInstance>;
}

export interface NormalizedOpenCodeRuntimeOptions {
  startupTimeoutMs: number;
  modelDiscoveryTimeoutMs: number;
  requestTimeoutMs: number;
  unavailableRetryMs: number;
  sseRetryDelayMs: number;
  sseHeartbeatTimeoutMs: number;
  modelCacheTtlMs: number;
  shutdownStartupGraceMs: number;
  shutdownNativeForkGraceMs: number;
  now: () => number;
  requiresExecutable: boolean;
  createInstance: (input: { signal: AbortSignal }) => Promise<OpenCodeInstance>;
}

export function normalizeOpenCodeRuntimeOptions(options: OpenCodeRuntimeOptions): NormalizedOpenCodeRuntimeOptions {
  return {
    startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_OPENCODE_STARTUP_TIMEOUT_MS,
    modelDiscoveryTimeoutMs: options.modelDiscoveryTimeoutMs ?? DEFAULT_OPENCODE_MODEL_DISCOVERY_TIMEOUT_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_OPENCODE_REQUEST_TIMEOUT_MS,
    unavailableRetryMs: options.unavailableRetryMs ?? DEFAULT_OPENCODE_UNAVAILABLE_RETRY_MS,
    sseRetryDelayMs: options.sseRetryDelayMs ?? DEFAULT_OPENCODE_SSE_RETRY_DELAY_MS,
    sseHeartbeatTimeoutMs: options.sseHeartbeatTimeoutMs ?? DEFAULT_OPENCODE_SSE_HEARTBEAT_TIMEOUT_MS,
    modelCacheTtlMs: options.modelCacheTtlMs ?? DEFAULT_OPENCODE_MODEL_CACHE_TTL_MS,
    shutdownStartupGraceMs:
      options.shutdownStartupGraceMs ?? DEFAULT_OPENCODE_SHUTDOWN_STARTUP_GRACE_MS,
    shutdownNativeForkGraceMs:
      options.shutdownNativeForkGraceMs ?? DEFAULT_OPENCODE_SHUTDOWN_FORK_GRACE_MS,
    now: options.now ?? (() => Date.now()),
    requiresExecutable: options.createInstance === undefined,
    createInstance: options.createInstance ?? createOpenCodeInstance,
  };
}
