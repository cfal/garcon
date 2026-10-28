import type { SourceArtifact } from './source-artifact.js';

// Cutover artifacts keep this test protocol readable by future matrix orchestrators.
// The process harness also freezes these launch surfaces: server/main.ts (controller
// and executor modes), config/workspace/project/port/bind flags, GARCON_CONTROLLER_URL,
// and executor connection-url --advertise-url --no-tls. Readiness is the controller's
// `Started at http://...` line and the worker's JSON `executor-listening` (url) and
// `executor-connected` frames. Other log fields and private auth formats are not frozen.
// CLI launch uses cli/main.ts, --config-dir/--runtime, list agents --executor --json,
// start --agent shell --model sh --executor --cwd --json, and schedule create/show/delete
// with --definition/--expected-revision/--json. Results retain agents[].id, receipt.chatId,
// scheduledPrompt.id and revision. The shell agent's sh model and GARCON_TERMINAL_SHELL
// also remain available. Saved CLI contexts are opaque and read only by their own artifact.
export type CompatibilityCommand =
  | { kind: 'enroll'; direction: 'controller-connects' | 'executor-connects'; connectionUrl?: string }
  | { kind: 'inventory'; executorId: string }
  | { kind: 'catalog'; executorId: string }
  | { kind: 'contract-workflows'; executorId: string; projectPath: string; controllerConfig: string; workerConfig: string; home: string;
      cliArtifacts: readonly SourceArtifact[]; expectedUnsupported: readonly UnsupportedWorkflow[] }
  | { kind: 'terminal-resume'; executorId: string; terminalId: string; terminalRuntimeId: string; previousControllerId: string; workerConfig: string }
  | { kind: 'synthetic-turn'; executorId: string; projectPath: string; schemaVersion: number; chatId?: string }
  | { kind: 'saved-settings'; chatId: string };

export interface CompatibilityCredentials {
  readonly username: string;
  readonly password: string;
}

export type CompatibilityDriverRequest =
  | { readonly version: 1; readonly kind: 'prepare-auth'; readonly configDir: string }
  | { readonly version: 1; readonly kind: 'capture-cli-context' | 'check-cli-restart';
      readonly configDir: string; readonly runtime: 'controller' | 'executor'; readonly contextPath: string }
  | { readonly version: 1; readonly kind: 'command'; readonly baseUrl: string;
      readonly credentials: CompatibilityCredentials; readonly command: CompatibilityCommand };

export interface CompatibilityDriverResult {
  readonly version: 1;
  readonly result: Record<string, unknown>;
}

export interface ContractProbe {
  readonly surface: 'executor' | 'direct-cli' | 'gateway-cli';
  readonly name: string;
  readonly version: number;
}

export interface UnsupportedWorkflow {
  readonly workflow: string;
  readonly missing: readonly ContractProbe[];
}
