import {
  parseAgentNativeChildDescriptor,
  type AgentIntegration,
  type AgentNativeChildDescriptor,
  type AgentNativeChildEvent,
} from '@garcon/server-agent-interface';
import { effectiveExecutorId } from '../../../common/executors.js';
import type { ChatObservation } from '../../../common/chat-observation.js';
import type { TranscriptObservationLease } from '../ledger/observation.js';
import type { TranscriptLedgerService, TranscriptProducerLease } from '../ledger/service.js';
import type { SettingsStore } from '../settings/store.js';
import type { ChatIdAllocator } from './chat-id-allocator.js';
import type { ChatRegistryEntry } from './registry-contracts.js';
import type { IChatRegistry } from './store.js';

export const NATIVE_CHILDREN_PER_SOURCE = 1024;

interface ChildRoute {
  readonly parentKey: string | null;
  chatId: string | null;
  writer: TranscriptObservationLease | null;
  isWorking: boolean;
}

interface SourceRoute {
  readonly chatId: string;
  readonly lease: TranscriptProducerLease;
  readonly epoch: string;
  readonly agentId: string;
  readonly executorId: string;
  readonly children: Map<string, ChildRoute>;
  sessionId: string | null;
  retired: boolean;
  gapReported: boolean;
}

export interface NativeChildObserverOptions {
  readonly registry: IChatRegistry;
  readonly ledger: TranscriptLedgerService;
  readonly chatIds: Pick<ChatIdAllocator, 'allocate'>;
  readonly settings: Pick<SettingsStore, 'setSessionName' | 'ensureInNormal' | 'emitListChanged'>;
  readonly onError: (message: string, chatId: string) => void;
}

export class NativeChildObserverService {
  readonly #sources = new WeakMap<TranscriptProducerLease, SourceRoute>();
  readonly #children = new Map<string, ChildRoute>();

  constructor(private readonly options: NativeChildObserverOptions) {
    options.registry.onChatRemoved(chatId => this.retireChat(chatId));
  }

  registerSource(chatId: string, lease: TranscriptProducerLease, entry: ChatRegistryEntry): void {
    if (lease.closed || entry.nativeObservation || this.#sources.has(lease)) return;
    const source: SourceRoute = {
      chatId, lease, epoch: entry.agentOwnershipEpoch, agentId: entry.agentId,
      executorId: effectiveExecutorId(entry.executorId), children: new Map(),
      sessionId: entry.agentSessionId, retired: false, gapReported: false,
    };
    this.#sources.set(lease, source);
    lease.onClosed(() => {
      this.#retireSource(source);
      source.children.clear();
      this.#sources.delete(lease);
    });
  }

  projection(chatId: string): ChatObservation | null {
    if (!this.options.registry.getChat(chatId)?.nativeObservation) return null;
    const attached = this.capture(chatId) !== null;
    return { kind: 'native-child', captureStatus: attached ? 'attached' : 'detached',
      isWorking: attached && this.#children.get(chatId)?.isWorking === true };
  }

  capture(chatId: string): TranscriptObservationLease | null {
    const writer = this.#children.get(chatId)?.writer;
    return writer && !writer.closed ? writer : null;
  }

  retireChat(chatId: string): void {
    this.#children.get(chatId)?.writer?.close();
    this.#children.delete(chatId);
  }

  accept(chatId: string, lease: TranscriptProducerLease, integration: AgentIntegration, event: AgentNativeChildEvent): void {
    const source = this.#sources.get(lease);
    if (!source || source.retired || lease.closed || source.chatId !== chatId) return;
    try {
      const entry = this.#currentSource(source);
      if (!entry || integration.descriptor.id !== source.agentId
        || integration.producers.scope.executorId !== source.executorId || !integration.nativeChildObservation) {
        this.#retireSource(source);
        return;
      }
      if (event.type === 'native-child-capture-ended') {
        this.reportSourceGap(lease);
        this.#retireSource(source);
      } else if (event.type === 'native-child-created') {
        const child = parseAgentNativeChildDescriptor(event.child);
        if (!child || child.ref.ownerId !== source.agentId) { this.reportSourceGap(lease); return; }
        this.#admit(source, entry, child);
      } else if (event.type === 'native-child-gap' && event.childKey === null) {
        this.reportSourceGap(lease);
      } else {
        const route = source.children.get(event.childKey!);
        if (!route) { this.reportSourceGap(lease); return; }
        const writer = route.writer;
        if (!writer || writer.closed) return;
        if (event.type === 'native-child-rows') writer.publishRows(event.rows);
        else if (event.type === 'native-child-status') {
          writer.publishStatus(event.status);
          const isWorking = event.status === 'running';
          if (route.isWorking !== isWorking) {
            route.isWorking = isWorking;
            if (route.chatId) this.#changed(route.chatId);
          }
        }
        else if (event.type === 'native-child-gap') writer.publishGap();
        else if (event.type === 'native-child-detached') writer.close();
      }
    } catch {
      this.reportSourceGap(lease);
    }
  }

  reportSourceGap(lease: TranscriptProducerLease): void {
    const source = this.#sources.get(lease);
    if (!source) return;
    if (!source.gapReported) {
      source.gapReported = true;
      this.#report('Native child observation incomplete', source.chatId);
    }
    for (const route of source.children.values()) {
      try { if (route.writer && !route.writer.closed) route.writer.publishGap(); }
      catch { route.writer?.close(); }
    }
  }

  #currentSource(source: SourceRoute): ChatRegistryEntry | null {
    const entry = this.options.registry.getChat(source.chatId);
    if (!entry || entry.nativeObservation || entry.agentOwnershipEpoch !== source.epoch
      || entry.agentId !== source.agentId || effectiveExecutorId(entry.executorId) !== source.executorId) return null;
    if (source.sessionId !== null && entry.agentSessionId !== source.sessionId) return null;
    return entry;
  }

  #admit(source: SourceRoute, entry: ChatRegistryEntry, child: AgentNativeChildDescriptor): void {
    if (source.children.has(child.ref.key)) return;
    if (!entry.agentSessionId || source.children.size >= NATIVE_CHILDREN_PER_SOURCE) {
      this.reportSourceGap(source.lease);
      return;
    }
    source.sessionId = entry.agentSessionId;
    const route: ChildRoute = { parentKey: child.parentKey, chatId: null, writer: null, isWorking: true };
    // A failed registration cannot allocate another identity on replay.
    source.children.set(child.ref.key, route);
    const chatId = this.options.chatIds.allocate();
    try {
      this.options.ledger.initializeChat(chatId);
      this.options.registry.addChat({
        id: chatId, executorId: source.executorId, agentId: source.agentId,
        model: child.model ?? entry.model, projectPath: entry.projectPath,
        parentChatId: this.#displayParent(source, child.parentKey), lineage: null,
        preambleSelection: { revision: 0, orderedPreambleIds: [] },
        nativeObservation: {
          kind: 'native-child', sourceChatId: source.chatId, sourceOwnershipEpoch: source.epoch,
          sourceAgentSessionId: source.sessionId, child: child.ref,
          parentKey: child.parentKey, reportedModel: child.model,
        },
      });
      route.chatId = chatId;
      if (!source.retired && !source.lease.closed && this.#currentSource(source)) {
        route.writer = this.options.ledger.openObservation(chatId);
        this.#children.set(chatId, route);
        route.writer.onClosed(() => {
          route.writer = null;
          this.#children.delete(chatId);
          this.#changed(chatId);
        });
        this.#changed(chatId);
        if (source.gapReported) route.writer.publishGap();
      }
    } catch {
      if (!this.options.registry.hasChat(chatId)) this.options.ledger.deleteChat(chatId);
      route.writer?.close();
      this.#report('Native child observation admission failed', source.chatId);
    }
    if (this.options.registry.hasChat(chatId)) {
      void this.options.registry.flush().catch(() => this.#report('Native child registry save failed', chatId));
      void this.options.settings.setSessionName(chatId, child.label ?? 'Native subagent').catch(() => this.#report('Native child title save failed', chatId));
      void this.options.settings.ensureInNormal(chatId).catch(() => this.#report('Native child sidebar save failed', chatId));
    }
  }

  #displayParent(source: SourceRoute, parentKey: string | null): string {
    const visited = new Set<string>();
    while (parentKey && !visited.has(parentKey)) {
      visited.add(parentKey);
      const parent = source.children.get(parentKey);
      if (parent?.chatId && this.options.registry.hasChat(parent.chatId)) return parent.chatId;
      parentKey = parent?.parentKey ?? null;
    }
    return source.chatId;
  }

  #retireSource(source: SourceRoute): void {
    source.retired = true;
    for (const child of source.children.values()) child.writer?.close();
  }

  #changed(chatId: string): void {
    queueMicrotask(() => {
      try { this.options.settings.emitListChanged('observation-changed', chatId); }
      catch { this.#report('Native child list invalidation failed', chatId); }
    });
  }

  #report(message: string, chatId: string): void {
    try { this.options.onError(message, chatId); } catch { /* Observation diagnostics cannot fail parent publication. */ }
  }
}
