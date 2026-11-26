import path from 'node:path';
import { AgentIntegrationError, type AgentNativeChildHistoryRequest } from '@garcon/server-agent-interface';
import { NativeChildSnapshots } from '@garcon/server-agent-common/execution/native-child-snapshots';
import { ClaudeNativeChildObserver } from './native-child-observer.js';
import { loadClaudeChildHistory, parseClaudeChildRef } from './native-child-history.js';
import { buildClaudeCLIEnvironment } from './cli-environment.js';
import { claudeConfigHomeDir } from './native-path.js';
import { isVersionBefore } from './cli-version.js';
import type { ClaudeRunningSession } from './runtime-state.js';
import type { ClaudeStartRequest, ClaudeResumeRequest } from './runtime-types.js';

interface ClaudeNativeSourcePorts {
  session(rootId: string): ClaudeRunningSession | undefined;
  isShuttingDown(): boolean;
  hasResumeOwner(session: ClaudeRunningSession): boolean;
  hasRetiringWriter(rootId: string): boolean;
  hasPendingPermission(rootId: string): boolean;
}

export class ClaudeNativeChildSources {
  readonly #observers = new WeakMap<ClaudeRunningSession, ClaudeNativeChildObserver>();
  readonly #snapshots = new NativeChildSnapshots(rootId => this.#assertIdle(rootId));

  constructor(private readonly ports: ClaudeNativeSourcePorts) {}

  admit(rootId: string): () => void { return this.#snapshots.admit(rootId); }

  async *loadHistory(request: AgentNativeChildHistoryRequest) {
    parseClaudeChildRef(request.child);
    const snapshot = this.#snapshots.capture(request.child.key);
    try { yield* loadClaudeChildHistory(request, snapshot.assertUnchanged); }
    finally { snapshot.release(); }
  }

  hasNativeWork(session: ClaudeRunningSession): boolean {
    return session.activeTurn !== null || session.initialization !== null
      || this.ports.hasResumeOwner(session) || (session.process !== null
        && (session.backgroundTaskCount !== 0 || session.unownedProviderActivity || session.providerState !== 'idle'));
  }

  activity(session: ClaudeRunningSession): ClaudeNativeChildObserver | undefined {
    this.#snapshots.activity(session.id);
    return this.#observers.get(session);
  }

  retire(session: ClaudeRunningSession): void {
    this.activity(session)?.close();
    this.#observers.delete(session);
  }

  bind(session: ClaudeRunningSession, request: ClaudeStartRequest | ClaudeResumeRequest): void {
    const previous = this.#observers.get(session);
    if (previous?.publicationSignal === request.publicationSignal) return;
    previous?.close();
    this.#observers.delete(session);
    if (!request.publicationSignal || !request.nativePath) return;
    const env = buildClaudeCLIEnvironment(request.model, request.envOverrides);
    const configHomeDir = path.resolve(claudeConfigHomeDir({ configHomeDir: env.CLAUDE_CONFIG_DIR }));
    const observer = new ClaudeNativeChildObserver({
      configHomeDir, rootSessionId: session.id, rootNativePath: request.nativePath,
    }, request.publicationSignal, request.operation.publish, child => {
      this.#snapshots.remember(child.key, session.id);
    });
    this.#observers.set(session, observer);
  }

  configureInvocation(session: ClaudeRunningSession, args: string[], version: readonly [number, number, number]): void {
    if (isVersionBefore(version, [2, 1, 330])) this.retire(session);
    else args.push('--include-partial-messages', '--forward-subagent-text');
  }

  #assertIdle(rootId: string): void {
    const session = this.ports.session(rootId);
    if (this.ports.isShuttingDown() || this.ports.hasRetiringWriter(rootId)
      || (session && this.hasNativeWork(session)) || this.ports.hasPendingPermission(rootId)) {
      throw new AgentIntegrationError('SESSION_BUSY', 'The native Claude source is still running', true);
    }
  }
}
