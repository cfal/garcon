import type { ChatMessage } from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  type AgentLogger,
  type AgentTranscriptPage,
  type AgentTranscriptPreview,
} from '@garcon/server-agent-interface';
import { transcriptRevision } from '@garcon/server-agent-common/lib/transcript-revision';
import type { CodexAppServerClientOptions } from './app-server/client.js';
import { CodexAppServerClient } from './app-server/client.js';
import {
  PaginatedCodexHistorySource,
  type CodexPaginatedHistoryClient,
} from './app-server/paginated-history-source.js';
import {
  getCodexPreviewFromNativePath,
  loadCodexChatMessagePage,
  loadCodexChatMessages,
} from './history-loader.js';
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

  async loadPage(
    session: CodexChatEntry,
    page: { readonly limit: number; readonly offset: number },
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<AgentTranscriptPage | null> {
    const profile = await this.inspect(session, signal);
    if (!profile) return null;
    if (profile.mode === 'legacy') {
      return loadCodexChatMessagePage(
        profile.nativePath,
        page.limit,
        page.offset,
        this.#logger,
        signal,
      );
    }
    return this.#paginated(profile).loadPage(page, signal);
  }

  async preview(
    session: CodexChatEntry,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<AgentTranscriptPreview | null> {
    const profile = await this.inspect(session, signal);
    if (!profile) return null;
    if (profile.mode === 'legacy') {
      return getCodexPreviewFromNativePath(profile.nativePath, this.#logger, signal);
    }
    return this.#paginated(profile).preview(signal);
  }

  async revision(
    session: CodexChatEntry,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<string> {
    return transcriptRevision(await this.load(session, signal));
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
