import type { SourceArtifact } from './source-artifact.js';

// Core-1 artifacts keep this test protocol readable by future matrix orchestrators.
export type CompatibilityCommand =
  | { kind: 'enroll'; direction: 'controller-connects' | 'executor-connects'; connectionUrl?: string }
  | { kind: 'inventory'; executorId: string }
  | { kind: 'catalog'; executorId: string }
  | { kind: 'core-workflow'; executorId: string; projectPath: string; controllerConfig: string; workerConfig: string; home: string; cliArtifacts: readonly SourceArtifact[] }
  | { kind: 'terminal-resume'; executorId: string; terminalId: string; terminalRuntimeId: string; previousControllerId: string; workerConfig: string }
  | { kind: 'synthetic-turn'; executorId: string; projectPath: string; schemaVersion: number; chatId?: string }
  | { kind: 'saved-settings'; chatId: string };

export interface CompatibilityDriverRequest {
  readonly version: 1;
  readonly baseUrl: string;
  readonly authToken: string | null;
  readonly command: CompatibilityCommand;
}

export interface CompatibilityDriverResult {
  readonly version: 1;
  readonly result: Record<string, unknown>;
}
