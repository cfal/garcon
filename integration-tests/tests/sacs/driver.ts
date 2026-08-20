import type {
  AgentRunCommandRequest,
  StartChatCommandRequest,
} from '../../../common/chat-command-contracts.js';
import type {
  IntegrationFixture,
  IntegrationFixtureOptions,
} from '../../support/integration-fixture.js';

export interface SacsSteeringFacet {
  readonly kind: 'steering';
}

export interface SacsNativeSessionsFacet {
  readonly kind: 'native-sessions';
}

export interface SacsNativeHistoryImportFacet {
  readonly kind: 'native-history-import';
  prepare(
    fixture: IntegrationFixture,
    chatId: string,
  ): Promise<SacsPreparedHistorySource>;
}

export interface SacsLegacyTranscriptRow {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly timestamp: string;
}

export interface SacsPreparedHistorySource {
  corrupt(): Promise<void>;
  empty(): Promise<void>;
  restore(): Promise<void>;
  remove(): Promise<void>;
}

export interface SacsLegacyArtifactSnapshot {
  readonly path: string;
  readonly contents: string;
  readonly size: number;
  readonly modifiedAtMs: number;
}

export interface SacsReleasedJsonlFacet {
  latestRequestContext(fixture: IntegrationFixture): readonly string[];
  snapshotRelocatedSource(
    fixture: IntegrationFixture,
    chatId: string,
  ): Promise<SacsLegacyArtifactSnapshot>;
}

export interface SacsDirectoryScopedHistoryFacet {
  moveBindingToDifferentDirectory(
    fixture: IntegrationFixture,
    chatId: string,
  ): Promise<{ restore(): Promise<void> }>;
}

export interface SacsLegacyHistoryImportFacet {
  readonly kind: 'legacy-history-import';
  readonly releasedJsonl: SacsReleasedJsonlFacet | null;
  readonly directoryScoped: SacsDirectoryScopedHistoryFacet | null;
  prepare(
    fixture: IntegrationFixture,
    chatId: string,
    rows: readonly SacsLegacyTranscriptRow[],
  ): Promise<SacsPreparedHistorySource>;
}

export interface SacsHeldTurn {
  readonly requested: Promise<unknown>;
  allowCancellation(): void;
  release(): void;
}

export interface SacsDriverEnvironment {
  readonly id: string;
  readonly label: string;
  readonly fixtureOptions: IntegrationFixtureOptions;
  startRequest(fixture: IntegrationFixture, input: {
    chatId: string;
    projectPath: string;
    command: string;
  }): StartChatCommandRequest;
  runRequest(fixture: IntegrationFixture, input: {
    chatId: string;
    command: string;
  }): Omit<AgentRunCommandRequest, 'transcriptViewId'>;
  holdAssistant(fixture: IntegrationFixture, content: string): SacsHeldTurn;
  holdInterruptibleAssistant(fixture: IntegrationFixture, content: string): SacsHeldTurn;
  scriptAssistant(fixture: IntegrationFixture, content: string): void;
  markRequests(fixture: IntegrationFixture): number;
  requestCountSince(fixture: IntegrationFixture, cursor: number): number;
  userTextsSince(fixture: IntegrationFixture, cursor: number): readonly string[];
  assertSettled(fixture: IntegrationFixture): void;
  reset(): void;
  dispose(): void | Promise<void>;
}

export interface SacsDriverFactory {
  readonly id: string;
  readonly label: string;
  readonly steering: SacsSteeringFacet | null;
  readonly nativeSessions: SacsNativeSessionsFacet | null;
  readonly nativeHistoryImport: SacsNativeHistoryImportFacet | null;
  readonly legacyHistoryImport: SacsLegacyHistoryImportFacet | null;
  start(): Promise<SacsDriverEnvironment>;
}
