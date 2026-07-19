import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentChatReference } from '@garcon/server-agent-interface';
import type { IntegrationRegistry } from '../agents/integration-registry.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import type { ChatCarryOverStore } from './chat-carryover-store.js';
import type {
  ChatRegistryEntry,
  ChatRegistryPatch,
  ChatRegistryResolvedEntry,
  IChatRegistry,
} from './store.js';

const JOURNAL_VERSION = 1;

interface TransferIntent {
  readonly id: string;
  readonly kind: 'transfer';
  readonly chatId: string;
  readonly oldReference: AgentChatReference;
  readonly oldEpoch: string;
  readonly targetAgentId: string;
  readonly targetEpoch: string;
  readonly createdAt: string;
}

interface DeleteIntent {
  readonly id: string;
  readonly kind: 'delete';
  readonly chatId: string;
  readonly oldReference: AgentChatReference;
  readonly oldEpoch: string;
  readonly createdAt: string;
}

type OwnershipIntent = TransferIntent | DeleteIntent;

interface PersistedJournal {
  readonly version: typeof JOURNAL_VERSION;
  readonly intents: readonly OwnershipIntent[];
}

export class AgentOwnershipJournal {
  readonly #filePath: string;
  readonly #registry: IChatRegistry;
  readonly #carryOver: ChatCarryOverStore;
  readonly #integrations: IntegrationRegistry;
  #intents: OwnershipIntent[] = [];

  constructor(options: {
    workspaceDir: string;
    registry: IChatRegistry;
    carryOver: ChatCarryOverStore;
    integrations: IntegrationRegistry;
  }) {
    this.#filePath = path.join(options.workspaceDir, 'agent-ownership-journal.json');
    this.#registry = options.registry;
    this.#carryOver = options.carryOver;
    this.#integrations = options.integrations;
  }

  async initialize(): Promise<void> {
    this.#intents = await this.#load();
    const referencedEpochs = new Set(
      this.#intents.flatMap((intent) => intent.kind === 'transfer' ? [intent.targetEpoch] : []),
    );
    for (const chat of Object.values(this.#registry.listAllChats())) {
      referencedEpochs.add(chat.agentOwnershipEpoch);
    }
    await this.#carryOver.pruneOrphanedStaged(referencedEpochs);

    for (const intent of [...this.#intents]) {
      const current = this.#registry.getChat(intent.chatId);
      if (intent.kind === 'transfer') {
        if (matchesOldOwner(current, intent)) {
          await this.#carryOver.discardStaged(intent.chatId, intent.targetEpoch);
          await this.#remove(intent.id);
          continue;
        }
        if (current?.agentId === intent.targetAgentId && current.agentOwnershipEpoch === intent.targetEpoch) {
          await this.#finishTransfer(intent);
          continue;
        }
      } else {
        if (matchesOldOwner(current, intent)) {
          await this.#remove(intent.id);
          continue;
        }
        if (!current) {
          await this.#finishDelete(intent);
          continue;
        }
      }
      throw new Error(`Agent ownership journal integrity failure for chat ${intent.chatId}`);
    }
    await this.#carryOver.promoteCommittedStaged();
  }

  hasPending(chatId: string): boolean {
    return this.#intents.some((intent) => intent.chatId === chatId);
  }

  async transfer(options: {
    chatId: string;
    source: ChatRegistryEntry;
    targetAgentId: string;
    patch: ChatRegistryPatch;
    carryOverSegment: {
      agentId: string;
      model: string;
      messages: import('@garcon/common/chat-types').ChatMessage[];
    } | null;
  }): Promise<ChatRegistryResolvedEntry> {
    this.#assertAvailable(options.chatId);
    const sourceIntegration = this.#integrations.require(options.source.agentId);
    const oldReference = toAgentChatReference(
      sourceIntegration,
      options.chatId,
      options.source,
      this.#carryOver.getRevision(options.chatId),
    );
    const targetEpoch = crypto.randomUUID();
    await this.#carryOver.stageTransfer({
      chatId: options.chatId,
      targetEpoch,
      ownerId: options.targetAgentId,
      segment: options.carryOverSegment,
    });
    const intent: TransferIntent = {
      id: crypto.randomUUID(),
      kind: 'transfer',
      chatId: options.chatId,
      oldReference,
      oldEpoch: options.source.agentOwnershipEpoch,
      targetAgentId: options.targetAgentId,
      targetEpoch,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.#append(intent);
    } catch (error) {
      await this.#carryOver.discardStaged(options.chatId, targetEpoch);
      throw error;
    }

    let updated: ChatRegistryResolvedEntry | null;
    try {
      updated = await this.#registry.updateChat(options.chatId, {
        ...options.patch,
        agentId: options.targetAgentId,
        agentSessionId: null,
        nativeSession: null,
        agentOwnershipEpoch: targetEpoch,
      }, { flush: true });
    } catch (error) {
      const current = this.#registry.getChat(options.chatId);
      if (matchesOldOwner(current, intent)) {
        await this.#carryOver.discardStaged(options.chatId, targetEpoch);
        await this.#remove(intent.id);
        throw error;
      }
      if (matchesTargetOwner(current, intent)) {
        await this.#finishTransfer(intent);
        return { id: options.chatId, ...current };
      }
      throw error;
    }
    if (!updated) {
      const current = this.#registry.getChat(options.chatId);
      if (matchesOldOwner(current, intent)) {
        await this.#carryOver.discardStaged(options.chatId, targetEpoch);
        await this.#remove(intent.id);
      }
      throw new Error(`Session not found: ${options.chatId}`);
    }
    await this.#finishTransfer(intent);
    return updated;
  }

  async delete(chatId: string): Promise<void> {
    this.#assertAvailable(chatId);
    const source = this.#registry.getChat(chatId);
    if (!source) return;
    const integration = this.#integrations.require(source.agentId);
    const intent: DeleteIntent = {
      id: crypto.randomUUID(),
      kind: 'delete',
      chatId,
      oldReference: toAgentChatReference(
        integration,
        chatId,
        source,
        this.#carryOver.getRevision(chatId),
      ),
      oldEpoch: source.agentOwnershipEpoch,
      createdAt: new Date().toISOString(),
    };
    await this.#append(intent);
    this.#registry.removeChat(chatId);
    await this.#registry.flush();
    await this.#finishDelete(intent);
  }

  async #finishTransfer(intent: TransferIntent): Promise<void> {
    await this.#release(intent.oldReference, 'transferred');
    await this.#carryOver.promoteStaged(intent.chatId, intent.targetEpoch);
    await this.#remove(intent.id);
  }

  async #finishDelete(intent: DeleteIntent): Promise<void> {
    await this.#release(intent.oldReference, 'deleted');
    this.#carryOver.clear(intent.chatId);
    await this.#carryOver.flush();
    await this.#remove(intent.id);
  }

  async #release(reference: AgentChatReference, reason: 'deleted' | 'transferred'): Promise<void> {
    await this.#integrations.require(reference.agentId).transcript.release({
      chat: reference,
      reason,
      signal: new AbortController().signal,
    });
  }

  #assertAvailable(chatId: string): void {
    if (this.hasPending(chatId)) throw new Error(`Agent ownership change is pending for ${chatId}`);
  }

  async #append(intent: OwnershipIntent): Promise<void> {
    const next = [...this.#intents, intent];
    await this.#save(next);
    this.#intents = next;
  }

  async #remove(id: string): Promise<void> {
    const next = this.#intents.filter((intent) => intent.id !== id);
    await this.#save(next);
    this.#intents = next;
  }

  async #load(): Promise<OwnershipIntent[]> {
    try {
      const value = JSON.parse(await fs.readFile(this.#filePath, 'utf8')) as PersistedJournal;
      if (value.version !== JOURNAL_VERSION || !Array.isArray(value.intents)) {
        throw new Error('Invalid agent ownership journal');
      }
      return [...value.intents];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async #save(intents: readonly OwnershipIntent[]): Promise<void> {
    await writeJsonFileAtomic(this.#filePath, {
      version: JOURNAL_VERSION,
      intents,
    } satisfies PersistedJournal);
  }
}

function matchesOldOwner(
  current: ChatRegistryEntry | null,
  intent: OwnershipIntent,
): boolean {
  return current?.agentId === intent.oldReference.agentId
    && current.agentOwnershipEpoch === intent.oldEpoch
    && current.agentSessionId === intent.oldReference.agentSessionId
    && JSON.stringify(current.nativeSession) === JSON.stringify(intent.oldReference.nativeSession);
}

function matchesTargetOwner(
  current: ChatRegistryEntry | null,
  intent: TransferIntent,
): current is ChatRegistryEntry {
  return current?.agentId === intent.targetAgentId
    && current.agentOwnershipEpoch === intent.targetEpoch;
}
