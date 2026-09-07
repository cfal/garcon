import type { AgentCredentialReference } from '@garcon/common/agent-execution';
import type { JsonObject, JsonValue } from '@garcon/common/json';

export interface AgentHost {
  readonly agentId: string;
  readonly logger: AgentLogger;
  readonly storage: AgentScopedStorage;
  readonly environment: AgentEnvironmentReader;
  readonly apiProviders: AgentApiProviderReader;
}

export interface AgentHostFactory {
  forAgent(agentId: string): AgentHost;
}

export interface AgentScopedStorage {
  readonly rootDirectory: string;
  directory(namespace: string): Promise<string>;
  claimLegacyWorkspaceDirectory(name: string): Promise<AgentLegacyDirectoryClaim>;
}

export interface AgentLegacyDirectoryClaim {
  readonly moved: number;
  readonly skipped: number;
}

export interface AgentLogger {
  debug(message: string, fields?: JsonObject): void;
  info(message: string, fields?: JsonObject): void;
  warn(message: string, fields?: JsonObject): void;
  error(message: string, fields?: JsonObject): void;
}

export interface AgentEnvironmentReader {
  get(name: string): string | undefined;
}

export interface AgentApiProviderReader {
  resolveCredential(request: {
    readonly reference: AgentCredentialReference;
    readonly signal: AbortSignal;
  }): Promise<AgentResolvedCredential | null>;
}

export interface AgentResolvedCredential {
  readonly kind: string;
  readonly value: string;
}

export interface AgentMigrationStore {
  getVersion(): Promise<number>;
  read(key: string): Promise<JsonValue | undefined>;
  commit(request: {
    readonly expectedVersion: number;
    readonly nextVersion: number;
    readonly set: Readonly<Record<string, JsonValue>>;
    readonly delete: readonly string[];
  }): Promise<void>;
}
