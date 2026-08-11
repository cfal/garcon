import type { ChatMessage } from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  type AgentLogger,
} from '@garcon/server-agent-interface';
import type { CodexAppServerClientOptions } from './app-server/client.js';
import { CodexAppServerClient } from './app-server/client.js';
import {
  PaginatedCodexHistorySource,
  type CodexPaginatedHistoryClient,
} from './app-server/paginated-history-source.js';
import { loadCodexChatMessages } from './history-loader.js';
import {
  inspectCodexHistoryProfile,
  type CodexHistoryProfile,
} from './history-profile.js';
import type { CodexChatEntry } from './runtime-types.js';

const NEVER_ABORTED = new AbortController().signal;

export interface CodexHistoryServiceOptions {
  readonly createClient?: (options?: CodexAppServerClientOptions) => CodexPaginatedHistoryClient;
  readonly logger: AgentLogger;
}

export class CodexHistoryService {
  readonly #createClient: () => CodexPaginatedHistoryClient;
  readonly #logger: AgentLogger;

  constructor(options: CodexHistoryServiceOptions) {
    this.#createClient = () => (options.createClient?.() ?? new CodexAppServerClient());
    this.#logger = options.logger;
  }

  async inspect(
    session: CodexChatEntry,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<CodexHistoryProfile | null> {
    if (!session.nativePath) return null;
    return inspectCodexHistoryProfile({
      nativePath: session.nativePath,
      expectedThreadId: session.agentSessionId,
      signal,
    });
  }

  async load(
    session: CodexChatEntry,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<ChatMessage[]> {
    const profile = await this.inspect(session, signal);
    if (!profile) return [];
    if (profile.mode === 'legacy') {
      return loadCodexChatMessages(profile.nativePath, this.#logger, {
        throwOnError: true,
        signal,
      });
    }
    return this.#paginated(profile).load(signal);
  }

  #paginated(
    profile: Extract<CodexHistoryProfile, { mode: 'paginated' }>,
  ): PaginatedCodexHistorySource {
    assertCodexPaginatedHistoryMaterializable(profile, 'load-history');
    return new PaginatedCodexHistorySource(profile, this.#createClient);
  }
}

export function assertCodexPaginatedHistoryMaterializable(
  profile: Extract<CodexHistoryProfile, { mode: 'paginated' }>,
  operation: string,
): void {
  if (!profile.historyBase) return;
  throw new AgentIntegrationError(
    'OPERATION_UNSUPPORTED',
    'Codex paginated history with an inherited base is not supported',
    false,
    { operation, historyMode: 'paginated', provider: 'codex' },
  );
}
