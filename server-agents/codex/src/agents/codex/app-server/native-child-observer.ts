import { isRecord } from '@garcon/common/json';
import type { NativeChildStatus } from '@garcon/common/chat-observation';
import type { AgentNativeChildRef } from '@garcon/server-agent-interface';
import { NativeChildCaptureBudget, NATIVE_CHILD_CAPTURE_LIMITS } from '@garcon/server-agent-common/execution/native-child-capture-budget';
import { runtimeRows, type AgentRuntimeOperation, type AgentRuntimePublisher } from '@garcon/server-agent-common/execution/runtime-events';
import { convertCodexAppServerItem } from './converter.js';
import { codexChildRef } from './native-child-history.js';
import { parseCodexThreadItem, type CodexThreadItem, type JsonRpcNotification } from './protocol.js';

interface ChildRoute {
  readonly key: string;
  readonly publish: AgentRuntimePublisher;
  status: NativeChildStatus;
}

export class CodexNativeChildObserver {
  readonly #known = new Set<string>();
  readonly #spawned = new Set<string>();
  readonly #observedTurns = new Set<string>();
  readonly #active = new Map<string, string | null>();
  readonly #routes = new Map<string, ChildRoute>();
  readonly #suppressed = new Set<string>();
  readonly #budget = new NativeChildCaptureBudget<JsonRpcNotification>();
  #signal: AbortSignal | null = null;
  #publish: AgentRuntimePublisher | null = null;
  #uncertainActivity = false;
  #gapReported = false;
  #disposed = false;
  #admissionsClosed = false;
  readonly #abort = () => this.#endCapture();

  constructor(
    private readonly source: { readonly codexHome: string; readonly rootThreadId: string },
    private readonly onCreated: (child: AgentNativeChildRef) => void = () => {},
  ) {}

  get ownsNativeWork(): boolean { return this.#uncertainActivity || this.#active.size > 0; }

  bind(signal: AbortSignal, publish: AgentRuntimePublisher): void {
    if (this.#disposed || this.#signal === signal) return;
    this.#endCapture();
    this.#signal?.removeEventListener('abort', this.#abort);
    this.#signal = signal;
    this.#publish = publish;
    this.#gapReported = false;
    if (!signal.aborted) signal.addEventListener('abort', this.#abort, { once: true });
  }

  acceptSafely(notification: JsonRpcNotification, rootOperation: AgentRuntimeOperation | null): boolean {
    if (this.#disposed || !isRecord(notification.params)) return false;
    const params = notification.params;
    const threadId = identity(params.threadId);
    if (!threadId) return false;
    const root = threadId === this.source.rootThreadId;
    try {
      const currentTerminal = root || this.#observeNativeWork(threadId, notification);
      this.#observeAdmissions(notification);
      if (!this.#signal || this.#signal.aborted || !this.#publish) return !root;
      if (root) {
        if (rootOperation && (notification.method === 'item/started' || notification.method === 'item/completed')) {
          this.#observeSpawn(params.item, threadId, rootOperation.publish);
        }
        return false;
      }
      const route = this.#routes.get(threadId);
      if (!route) {
        if (!this.#admissionsClosed && !this.#known.has(threadId) && !this.#suppressed.has(threadId) && capturable(notification.method)) {
          const buffered = this.#budget.buffer(threadId, notification);
          if (buffered !== 'buffered') this.#retire(threadId);
        }
        return true;
      }
      switch (notification.method) {
        case 'item/started':
          this.#observeSpawn(params.item, threadId, route.publish);
          break;
        case 'item/completed': {
          const item = parseCodexThreadItem(params.item, 'child item');
          this.#observeSpawn(item, threadId, route.publish);
          this.#item(threadId, identity(params.turnId), item);
          break;
        }
        case 'turn/started': this.#status(threadId, 'running'); break;
        case 'turn/completed': {
          if (!isRecord(params.turn) || !Array.isArray(params.turn.items)) throw new TypeError('Invalid child terminal');
          for (const item of params.turn.items) this.#item(threadId, identity(params.turn.id), parseCodexThreadItem(item, 'child terminal item'));
          const status = params.turn.status;
          if (!currentTerminal) break;
          if (status === 'completed') this.#status(threadId, 'completed');
          else if (status === 'failed') this.#status(threadId, 'failed');
          else if (status === 'interrupted') this.#status(threadId, 'interrupted');
          else throw new TypeError('Invalid child terminal status');
          break;
        }
      }
      return true;
    } catch {
      if (root) this.#gap(null);
      else this.#retire(threadId);
      return !root;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#endCapture();
    this.#disposed = true;
    this.#signal?.removeEventListener('abort', this.#abort);
    this.#known.clear();
    this.#spawned.clear();
    this.#observedTurns.clear();
    this.#active.clear();
    this.#suppressed.clear();
  }

  #observeNativeWork(threadId: string, notification: JsonRpcNotification): boolean {
    if (notification.method !== 'turn/started' && notification.method !== 'turn/completed') return true;
    const params = notification.params;
    const turn = isRecord(params) && isRecord(params.turn) ? params.turn : null;
    const turnId = identity(turn?.id);
    if (!turnId || !turn || (notification.method === 'turn/completed'
      && turn.status !== 'completed' && turn.status !== 'failed' && turn.status !== 'interrupted')) {
      this.#uncertainActivity = true;
      throw new TypeError('Invalid native child turn identity');
    }
    if (this.#observedTurns.size < NATIVE_CHILD_CAPTURE_LIMITS.children) this.#observedTurns.add(threadId);
    else if (!this.#observedTurns.has(threadId)) this.#uncertainActivity = true;
    if (notification.method === 'turn/started') {
      if (this.#active.size >= NATIVE_CHILD_CAPTURE_LIMITS.children && !this.#active.has(threadId)) this.#uncertainActivity = true;
      else this.#active.set(threadId, turnId);
      return true;
    }
    if (this.#active.has(threadId) && this.#active.get(threadId) !== null && this.#active.get(threadId) !== turnId) return false;
    this.#active.delete(threadId);
    return true;
  }

  #observeAdmissions(notification: JsonRpcNotification): void {
    if (notification.method !== 'item/started' && notification.method !== 'item/completed') return;
    const item = isRecord(notification.params) ? notification.params.item : null;
    if (!isRecord(item)) return;
    const spawned = item.type === 'subAgentActivity' && item.kind === 'started' ? [item.agentThreadId]
      : item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && item.status === 'completed'
        && Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    for (const id of spawned) {
      const child = identity(id);
      if (!child || child === this.source.rootThreadId) { this.#uncertainActivity = true; continue; }
      if (this.#spawned.has(child)) continue;
      if (this.#spawned.size >= NATIVE_CHILD_CAPTURE_LIMITS.children) { this.#uncertainActivity = true; continue; }
      this.#spawned.add(child);
      if (!this.#active.has(child) && !this.#observedTurns.has(child)) {
        if (this.#active.size >= NATIVE_CHILD_CAPTURE_LIMITS.children) this.#uncertainActivity = true;
        else this.#active.set(child, null);
      }
    }
    if ((item.type === 'subAgentActivity' && item.kind === 'interacted')
      || (item.type === 'collabAgentToolCall' && (item.tool === 'sendInput' || item.tool === 'resumeAgent'))) {
      // A terminal can precede another queued wake. The wire exposes no drain receipt.
      // https://github.com/openai/codex/blob/ccf9be8cc458bd6b8336fe84d68d8893f2691a5e/codex-rs/core/src/tasks/mod.rs#L1047-L1117
      this.#uncertainActivity = true;
    }
  }

  #observeSpawn(value: unknown, parentThreadId: string, publish: AgentRuntimePublisher): void {
    if (!isRecord(value) || (value.type !== 'subAgentActivity' && value.type !== 'collabAgentToolCall')) return;
    const item = parseCodexThreadItem(value, 'native spawn');
    this.#spawn(item, parentThreadId, publish);
  }

  #spawn(item: CodexThreadItem, parentThreadId: string, publish: AgentRuntimePublisher): void {
    if (this.#admissionsClosed) return;
    const children = item.type === 'subAgentActivity' && item.kind === 'started' ? [item.agentThreadId]
      : item.type === 'collabAgentToolCall' && item.tool === 'spawnAgent' && item.status === 'completed'
        && item.senderThreadId === parentThreadId ? item.receiverThreadIds : [];
    for (const childThreadId of children) {
      if (!identity(childThreadId) || childThreadId === this.source.rootThreadId
        || this.#known.has(childThreadId) || this.#suppressed.has(childThreadId)) continue;
      if (this.#known.size >= NATIVE_CHILD_CAPTURE_LIMITS.children) {
        this.#uncertainActivity = true;
        this.#gap(null);
        return;
      }
      this.#known.add(childThreadId);
      const ref = codexChildRef({ ...this.source, childThreadId, parentThreadId });
      const route: ChildRoute = { key: ref.key, publish, status: 'running' };
      this.#routes.set(childThreadId, route);
      try {
        this.onCreated(ref);
        publish({ type: 'native-child-created', child: {
          ref, parentKey: this.#routes.get(parentThreadId)?.key ?? null,
          label: item.type === 'subAgentActivity' ? item.agentPath.slice(0, 256) || null : null,
          model: (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall') ? item.model ?? null : null,
        } });
        publish({ type: 'native-child-status', childKey: ref.key, status: 'running' });
        for (const early of this.#budget.take(childThreadId)) this.acceptSafely(early, null);
      } catch { this.#retire(childThreadId); }
    }
  }

  #item(threadId: string, turnId: string | null, item: CodexThreadItem): void {
    const route = this.#routes.get(threadId);
    if (!route) return;
    if (!turnId || !identity(item.id)) throw new TypeError('Missing child item identity');
    const remembered = this.#budget.remember(threadId, JSON.stringify([turnId, item.id]));
    if (remembered === 'duplicate') return;
    if (remembered === 'limit') throw new TypeError('Child item identity limit');
    const messages = convertCodexAppServerItem(item, new Date().toISOString(), { includeUserMessages: true });
    if (messages.length) route.publish({ type: 'native-child-rows', childKey: route.key,
      rows: runtimeRows(messages).map((row, withinSourceOrdinal) => ({ ...row,
        providerMeta: { turnId, itemId: item.id, withinSourceOrdinal },
      })),
    });
  }

  #status(threadId: string, status: NativeChildStatus): void {
    const route = this.#routes.get(threadId);
    if (!route || route.status === status) return;
    route.status = status;
    route.publish({ type: 'native-child-status', childKey: route.key, status });
  }

  #retire(threadId: string): void {
    const route = this.#routes.get(threadId);
    this.#gap(route?.key ?? null);
    if (route) {
      this.#emit(route.publish, { type: 'native-child-detached', childKey: route.key });
      this.#routes.delete(threadId);
    }
    this.#budget.forget(threadId);
    this.#suppress(threadId);
  }

  #suppress(threadId: string): void {
    if (this.#suppressed.size < NATIVE_CHILD_CAPTURE_LIMITS.children) this.#suppressed.add(threadId);
    else this.#admissionsClosed = true;
  }

  #endCapture(): void {
    if (this.#budget.pendingChildren) this.#gap(null);
    for (const route of this.#routes.values()) this.#emit(route.publish, { type: 'native-child-detached', childKey: route.key });
    this.#routes.clear();
    this.#budget.clear();
    this.#publish = null;
  }

  #gap(childKey: string | null): void {
    if (!this.#publish || (childKey === null && this.#gapReported)) return;
    if (childKey === null) this.#gapReported = true;
    this.#emit(this.#publish, { type: 'native-child-gap', childKey });
  }

  #emit(publish: AgentRuntimePublisher, event: Parameters<AgentRuntimePublisher>[0]): void {
    if (this.#signal?.aborted) return;
    try { publish(event); } catch { /* Observation cannot fail parent notification processing. */ }
  }
}

function identity(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function capturable(method: string): boolean {
  return method === 'item/started' || method === 'item/completed' || method === 'turn/started' || method === 'turn/completed';
}
