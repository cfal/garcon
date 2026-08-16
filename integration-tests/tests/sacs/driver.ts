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
  start(): Promise<SacsDriverEnvironment>;
}
