import { isRecord } from '@garcon/common/json';
import type { AgentRuntimeOperation, AgentRuntimePublisher } from '@garcon/server-agent-common/execution/runtime-events';
import { NativeChildCaptureBudget, NATIVE_CHILD_CAPTURE_LIMITS } from '@garcon/server-agent-common/execution/native-child-capture-budget';
import type { NativeChildStatus } from '@garcon/common/chat-observation';
import type { AgentNativeChildDescriptor, AgentNativeChildRef } from '@garcon/server-agent-interface';
import type { ClaudeCLIMessage } from './cli-protocol.js';
import { claudeChildRef, type ClaudeChildLocator } from './native-child-history.js';
import { convertClaudeChildContent } from './native-child-content.js';

interface Invocation {
  readonly operation: AgentRuntimeOperation;
  confirmed: boolean;
  label: string | null;
  model: string | null;
}
interface ChildRoute {
  readonly key: string;
  readonly publish: AgentRuntimePublisher;
  status: NativeChildStatus;
  runId: string | null;
}

export class ClaudeNativeChildObserver {
  readonly #calls = new Map<string, Invocation>();
  readonly #children = new Map<string, ChildRoute>();
  readonly #suppressed = new Set<string>();
  readonly #budget = new NativeChildCaptureBudget<ClaudeCLIMessage>();
  #closed = false;
  #admissionsClosed = false;
  #gapReported = false;
  #runId: string | null = null;
  readonly #abort = () => this.close();

  constructor(
    private readonly source: Omit<ClaudeChildLocator, 'agentId'>,
    readonly publicationSignal: AbortSignal,
    private readonly publishSource: AgentRuntimePublisher,
    private readonly onCreated: (child: AgentNativeChildRef) => void = () => {},
  ) {
    if (publicationSignal.aborted) this.#closed = true;
    else publicationSignal.addEventListener('abort', this.#abort, { once: true });
  }

  observeRootFrameSafely(frame: ClaudeCLIMessage, operation: AgentRuntimeOperation | null): void {
    if (this.#closed) return;
    try { this.#assertSource(frame); this.#rootFrame(frame, operation); }
    catch { this.#gap(null); }
  }

  acceptContentSafely(frame: ClaudeCLIMessage): void {
    if (this.#closed) return;
    const agentId = boundedId(frame.agent_id);
    try {
      this.#assertSource(frame);
      if (!agentId) { this.#gap(null); return; }
      if (this.#suppressed.has(agentId)) return;
      const route = this.#children.get(agentId);
      if (!route) {
        if (!this.#admissionsClosed) this.#buffer(agentId, frame);
        return;
      }
      const uuid = boundedId(frame.uuid);
      if (!uuid) throw new TypeError('Missing Claude child frame identity');
      const remembered = this.#budget.remember(agentId, uuid);
      if (remembered === 'duplicate') return;
      if (remembered === 'limit') throw new TypeError('Claude child identity limit');
      const rows = convertClaudeChildContent(frame,
        typeof frame.timestamp === 'string' ? frame.timestamp : new Date().toISOString());
      if (rows.length) route.publish({ type: 'native-child-rows', childKey: route.key, rows });
    } catch {
      if (agentId) this.#retire(agentId, true);
      else this.#gap(null);
    }
  }

  #assertSource(frame: ClaudeCLIMessage): void {
    if (frame.session_id !== undefined && frame.session_id !== this.source.rootSessionId) {
      throw new TypeError('Claude child source identity changed');
    }
  }

  close(): void {
    if (this.#closed) return;
    if (this.#budget.pendingChildren) this.#gap(null);
    this.#closed = true;
    for (const route of this.#children.values()) this.#emit(route.publish, { type: 'native-child-detached', childKey: route.key });
    this.#children.clear();
    this.#calls.clear();
    this.#budget.clear();
    this.#suppressed.clear();
    this.publicationSignal.removeEventListener('abort', this.#abort);
  }

  abandonInvocations(): void { this.#calls.clear(); }

  #rootFrame(frame: ClaudeCLIMessage, operation: AgentRuntimeOperation | null): void {
    if (operation && this.#runId !== operation.runId) {
      this.#calls.clear();
      this.#runId = operation.runId;
    }
    // Saved interrupted calls can be re-emitted without isReplay. Only root API partials
    // distinguish live generation on CLI 2.1.330; nested forwarding has no such evidence.
    if (!this.#admissionsClosed && operation && frame.type === 'stream_event' && frame.parent_tool_use_id == null
      && isRecord(frame.event) && frame.event.type === 'content_block_start') {
      const block = frame.event.content_block;
      if (!isRecord(block) || block.type !== 'tool_use' || block.name !== 'Agent') return;
      const id = boundedId(block.id);
      if (!id) return;
      if (this.#calls.size >= NATIVE_CHILD_CAPTURE_LIMITS.children) { this.#gap(null); return; }
      if (!this.#calls.has(id)) this.#calls.set(id, { operation, confirmed: false, label: null, model: null });
    }
    if (operation && frame.type === 'assistant' && frame.isReplay !== true
      && Array.isArray(frame.message?.content)) {
      for (const block of frame.message.content) {
        if (!isRecord(block) || block.type !== 'tool_use' || block.name !== 'Agent') continue;
        const call = typeof block.id === 'string' ? this.#calls.get(block.id) : undefined;
        if (!call || call.operation !== operation || !isRecord(block.input)) continue;
        if (block.input.resume) { this.#calls.delete(String(block.id)); continue; }
        call.confirmed = true;
        call.label = label(block.input.description);
        call.model = label(block.input.model);
      }
    }
    if (frame.type !== 'system') return;
    const agentId = boundedId(frame.task_id);
    if (!agentId || this.#suppressed.has(agentId)) return;
    if (frame.subtype === 'task_started' && frame.task_type === 'local_agent') {
      const existing = this.#children.get(agentId);
      if (existing) {
        existing.runId = boundedId(frame.run_id);
        this.#status(agentId, 'running');
        return;
      }
      if (this.#admissionsClosed) return;
      const call = typeof frame.tool_use_id === 'string' ? this.#calls.get(frame.tool_use_id) : undefined;
      if (!call?.confirmed) { this.#retire(agentId, false); return; }
      this.#calls.delete(frame.tool_use_id!);
      if (this.#children.size + this.#suppressed.size >= NATIVE_CHILD_CAPTURE_LIMITS.children) { this.#gap(null); return; }
      const ref = claudeChildRef({ ...this.source, agentId });
      const descriptor: AgentNativeChildDescriptor = {
        ref, parentKey: null, label: label(frame.description) ?? call.label, model: call.model,
      };
      const route: ChildRoute = { key: ref.key, publish: call.operation.publish, status: 'running', runId: boundedId(frame.run_id) };
      this.#children.set(agentId, route);
      try {
        this.onCreated(ref);
        route.publish({ type: 'native-child-created', child: descriptor });
        route.publish({ type: 'native-child-status', childKey: ref.key, status: 'running' });
        for (const early of this.#budget.take(agentId)) this.acceptContentSafely(early);
      } catch { this.#retire(agentId, true); }
      return;
    }
    const status = frame.subtype === 'task_updated' && isRecord(frame.patch) ? frame.patch.status : frame.status;
    if (frame.subtype !== 'task_notification' && frame.subtype !== 'task_updated') return;
    const runId = boundedId(frame.run_id);
    const route = this.#children.get(agentId);
    if (runId && route?.runId && runId !== route.runId) return;
    if (status === 'completed' || status === 'failed') this.#status(agentId, status);
    else if (status === 'stopped' || status === 'killed') this.#status(agentId, 'interrupted');
  }

  #status(agentId: string, status: NativeChildStatus): void {
    const route = this.#children.get(agentId);
    if (!route || route.status === status) return;
    route.status = status;
    this.#emit(route.publish, { type: 'native-child-status', childKey: route.key, status });
  }

  #buffer(agentId: string, frame: ClaudeCLIMessage): void {
    const result = this.#budget.buffer(agentId, frame);
    if (result !== 'buffered') this.#retire(agentId, true);
  }

  #retire(agentId: string, gap: boolean): void {
    const route = this.#children.get(agentId);
    if (gap) this.#gap(route?.key ?? null);
    if (route) {
      this.#emit(route.publish, { type: 'native-child-detached', childKey: route.key });
      this.#children.delete(agentId);
    }
    this.#budget.forget(agentId);
    if (this.#suppressed.size < NATIVE_CHILD_CAPTURE_LIMITS.children) this.#suppressed.add(agentId);
    else {
      this.#admissionsClosed = true;
      this.#calls.clear();
      this.#gap(null);
    }
  }

  #gap(childKey: string | null): void {
    if (childKey === null && this.#gapReported) return;
    if (childKey === null) this.#gapReported = true;
    this.#emit(this.publishSource, { type: 'native-child-gap', childKey });
  }

  #emit(publish: AgentRuntimePublisher, event: Parameters<AgentRuntimePublisher>[0]): void {
    if (this.publicationSignal.aborted) return;
    try { publish(event); } catch { /* Observation cannot fail the parent transport. */ }
  }
}

function boundedId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

function label(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 256) : null;
}
