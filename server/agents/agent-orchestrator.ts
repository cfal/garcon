// Coordinates Garcon-owned child agents using forked chat sessions.

import { EventEmitter } from 'events';
import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import {
  isAmpAgentMode,
  isClaudeThinkingMode,
  isPermissionMode,
  isThinkingMode,
  normalizeAmpAgentMode,
  normalizeClaudeThinkingMode,
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../common/chat-modes.js';
import type { RunAgentTurnOptions } from './session-types.js';
import type { IChatRegistry } from '../chats/store.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import {
  type AgentOrchestration,
  type AgentOrchestrationAbortRequest,
  type AgentOrchestrationChild,
  type AgentOrchestrationChildStatus,
  type AgentOrchestrationSpawnRequest,
  type AgentOrchestrationTaskRequest,
  type AgentOrchestrationWaitRequest,
  isFinalOrchestrationStatus,
} from '../../common/agent-orchestration.js';

const STORE_VERSION = 1;
const DEFAULT_CONCURRENCY_LIMIT = 3;
const MAX_CONCURRENCY_LIMIT = 8;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60_000;
const TASK_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

interface SettingsDep {
  ensureInNormal(chatId: string): Promise<void>;
  setSessionName(chatId: string, title: string): Promise<void>;
}

interface MetadataDep {
  addNewChatMetadata(chatId: string, command: string): void;
}

interface QueueDep {
  submit(chatId: string, command: string, options: RunAgentTurnOptions): Promise<void>;
  abort(chatId: string): Promise<boolean>;
}

interface AgentsDep {
  supportsFork(agentId: string): boolean;
  isAgentSessionRunning(agentId: string, agentSessionId: string | null | undefined): boolean;
}

interface ForkChatDep {
  sourceSession: unknown;
  sourceChatId: string;
  targetChatId: string;
  registry: IChatRegistry;
  settings: SettingsDep;
  metadata: MetadataDep;
  forkAgentSession?: (args: {
    sourceSession: unknown;
    sourceChatId: string;
    targetChatId: string;
    threadSource?: 'user' | 'subagent';
  }) => Promise<{ agentSessionId: string; nativePath: string | null } | null>;
  supportsFork?: (agentId: string) => boolean;
  threadSource?: 'user' | 'subagent';
}

export interface AgentOrchestratorOptions {
  workspaceDir: string;
  registry: IChatRegistry;
  settings: SettingsDep;
  metadata: MetadataDep;
  queue: QueueDep;
  agents: AgentsDep;
  forkChatFileCopy: (args: ForkChatDep) => Promise<{
    chatId: string;
    agentId: string;
    agentSessionId: string;
    nativePath: string | null;
  }>;
  forkAgentSession?: ForkChatDep['forkAgentSession'];
}

interface PersistedOrchestrationSnapshot {
  version: number;
  orchestrations: AgentOrchestration[];
}

type ChildUpdatedCallback = (orchestration: AgentOrchestration, child: AgentOrchestrationChild) => void;

export class AgentOrchestrator extends EventEmitter {
  #workspaceDir: string;
  #registry: IChatRegistry;
  #settings: SettingsDep;
  #metadata: MetadataDep;
  #queue: QueueDep;
  #agents: AgentsDep;
  #forkChatFileCopy: AgentOrchestratorOptions['forkChatFileCopy'];
  #forkAgentSession: AgentOrchestratorOptions['forkAgentSession'];
  #orchestrations = new Map<string, AgentOrchestration>();
  #childToOrchestration = new Map<string, string>();
  #saveScheduled = false;

  constructor(options: AgentOrchestratorOptions) {
    super();
    this.#workspaceDir = options.workspaceDir;
    this.#registry = options.registry;
    this.#settings = options.settings;
    this.#metadata = options.metadata;
    this.#queue = options.queue;
    this.#agents = options.agents;
    this.#forkChatFileCopy = options.forkChatFileCopy;
    this.#forkAgentSession = options.forkAgentSession;
  }

  async init(): Promise<void> {
    try {
      const raw = await fs.readFile(this.#storePath(), 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedOrchestrationSnapshot>;
      const orchestrations = Array.isArray(parsed.orchestrations) ? parsed.orchestrations : [];
      for (const orchestration of orchestrations) {
        const normalized = normalizePersistedOrchestration(orchestration);
        this.#orchestrations.set(normalized.id, normalized);
        for (const child of normalized.children) {
          this.#childToOrchestration.set(child.childChatId, normalized.id);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  onChildUpdated(cb: ChildUpdatedCallback): void {
    this.on('child-updated', cb);
  }

  list(parentChatId?: string): AgentOrchestration[] {
    const values = Array.from(this.#orchestrations.values());
    const filtered = parentChatId ? values.filter((item) => item.parentChatId === parentChatId) : values;
    return filtered.map(cloneOrchestration);
  }

  get(orchestrationId: string): AgentOrchestration | null {
    const orchestration = this.#orchestrations.get(orchestrationId);
    return orchestration ? cloneOrchestration(orchestration) : null;
  }

  async spawn(request: AgentOrchestrationSpawnRequest): Promise<AgentOrchestration> {
    const parentChatId = requireNonEmptyString(request.parentChatId, 'parentChatId');
    const parent = this.#registry.getChat(parentChatId);
    if (!parent) throw new Error(`Parent chat not found: ${parentChatId}`);
    if (!parent.agentSessionId) throw new Error(`Parent chat has no agent session: ${parentChatId}`);
    if (!this.#agents.supportsFork(parent.agentId)) {
      throw new Error(`Fork unsupported for agent: ${parent.agentId}`);
    }
    if (this.#agents.isAgentSessionRunning(parent.agentId, parent.agentSessionId)) {
      throw new Error('Cannot spawn subagents while the parent chat is processing');
    }

    const tasks = normalizeTasks(request.tasks);
    const now = new Date().toISOString();
    const orchestration: AgentOrchestration = {
      id: crypto.randomUUID(),
      parentChatId,
      createdAt: now,
      updatedAt: now,
      status: 'starting',
      concurrencyLimit: clampConcurrency(request.concurrencyLimit),
      children: tasks.map((task) => ({
        id: crypto.randomUUID(),
        parentChatId,
        childChatId: this.#nextChatId(),
        taskName: task.taskName,
        prompt: task.prompt,
        role: task.role,
        status: 'starting',
        createdAt: now,
        updatedAt: now,
        model: task.model ?? parent.model ?? null,
      })),
    };

    this.#orchestrations.set(orchestration.id, orchestration);
    for (const child of orchestration.children) {
      this.#childToOrchestration.set(child.childChatId, orchestration.id);
    }
    await this.#saveNow();

    await runBounded(orchestration.children, orchestration.concurrencyLimit, (child) =>
      this.#startChild(orchestration, child, tasks.find((task) => task.taskName === child.taskName)!, parentChatId),
    );

    this.#refreshStatus(orchestration);
    await this.#saveNow();
    return cloneOrchestration(orchestration);
  }

  async wait(request: AgentOrchestrationWaitRequest): Promise<{
    orchestration: AgentOrchestration;
    timedOut: boolean;
  }> {
    const orchestration = this.#requireOrchestration(request.orchestrationId);
    const childIds = new Set(request.childIds?.filter(Boolean) ?? orchestration.children.map((child) => child.id));
    const timeoutMs = clampWaitTimeout(request.timeoutMs);

    if (this.#areChildrenFinal(orchestration, childIds)) {
      return { orchestration: cloneOrchestration(orchestration), timedOut: false };
    }

    return new Promise((resolve) => {
      let done = false;
      const cleanup = () => {
        done = true;
        clearTimeout(timeout);
        this.off('child-updated', onUpdate);
      };
      const finish = (timedOut: boolean) => {
        if (done) return;
        cleanup();
        resolve({ orchestration: cloneOrchestration(orchestration), timedOut });
      };
      const onUpdate = (updated: AgentOrchestration) => {
        if (updated.id !== orchestration.id) return;
        if (this.#areChildrenFinal(orchestration, childIds)) finish(false);
      };
      const timeout = setTimeout(() => finish(true), timeoutMs);
      this.on('child-updated', onUpdate);
    });
  }

  async abort(request: AgentOrchestrationAbortRequest): Promise<AgentOrchestration> {
    const orchestration = this.#requireOrchestration(request.orchestrationId);
    const childIds = new Set(request.childIds?.filter(Boolean) ?? orchestration.children.map((child) => child.id));
    await Promise.all(orchestration.children
      .filter((child) => childIds.has(child.id) && !isFinalOrchestrationStatus(child.status))
      .map(async (child) => {
        await this.#queue.abort(child.childChatId).catch(() => false);
        this.#updateChild(orchestration, child, 'aborted');
      }));
    this.#refreshStatus(orchestration);
    await this.#saveNow();
    return cloneOrchestration(orchestration);
  }

  recordMessages(chatId: string, messages: unknown[]): void {
    const located = this.#locateChild(chatId);
    if (!located) return;
    const preview = latestPreviewText(messages);
    if (!preview) return;
    located.child.resultPreview = preview;
    located.child.updatedAt = new Date().toISOString();
    this.#scheduleSave();
  }

  recordFinished(chatId: string): void {
    const located = this.#locateChild(chatId);
    if (!located) return;
    this.#updateChild(located.orchestration, located.child, 'completed');
  }

  recordFailed(chatId: string, error: string): void {
    const located = this.#locateChild(chatId);
    if (!located) return;
    located.child.error = error;
    this.#updateChild(located.orchestration, located.child, 'failed');
  }

  async flush(): Promise<void> {
    await this.#saveNow();
  }

  async #startChild(
    orchestration: AgentOrchestration,
    child: AgentOrchestrationChild,
    task: AgentOrchestrationTaskRequest,
    parentChatId: string,
  ): Promise<void> {
    const sourceSession = this.#registry.getChat(parentChatId);
    if (!sourceSession) throw new Error(`Parent chat not found: ${parentChatId}`);

    try {
      const forked = await this.#forkChatFileCopy({
        sourceSession,
        sourceChatId: parentChatId,
        targetChatId: child.childChatId,
        registry: this.#registry,
        settings: this.#settings,
        metadata: this.#metadata,
        forkAgentSession: this.#forkAgentSession,
        supportsFork: this.#agents.supportsFork.bind(this.#agents),
        threadSource: 'subagent',
      });
      await this.#settings.setSessionName(child.childChatId, `Subagent: ${task.taskName}`);
      child.agentId = forked.agentId;
      child.agentSessionId = forked.agentSessionId;
      child.nativePath = forked.nativePath;
      child.startedAt = new Date().toISOString();
      this.#updateChild(orchestration, child, 'running');
      await this.#queue.submit(child.childChatId, buildChildPrompt(parentChatId, task), runOptionsForTask(sourceSession, task));
    } catch (error) {
      child.error = (error as Error).message;
      this.#updateChild(orchestration, child, 'failed');
    }
  }

  #requireOrchestration(orchestrationId: string): AgentOrchestration {
    const id = requireNonEmptyString(orchestrationId, 'orchestrationId');
    const orchestration = this.#orchestrations.get(id);
    if (!orchestration) throw new Error(`Orchestration not found: ${id}`);
    return orchestration;
  }

  #locateChild(chatId: string): { orchestration: AgentOrchestration; child: AgentOrchestrationChild } | null {
    const orchestrationId = this.#childToOrchestration.get(chatId);
    if (!orchestrationId) return null;
    const orchestration = this.#orchestrations.get(orchestrationId);
    const child = orchestration?.children.find((candidate) => candidate.childChatId === chatId);
    return orchestration && child ? { orchestration, child } : null;
  }

  #updateChild(
    orchestration: AgentOrchestration,
    child: AgentOrchestrationChild,
    status: AgentOrchestrationChildStatus,
  ): void {
    const now = new Date().toISOString();
    child.status = status;
    child.updatedAt = now;
    if (isFinalOrchestrationStatus(status)) child.completedAt = child.completedAt ?? now;
    this.#refreshStatus(orchestration);
    this.emit('child-updated', cloneOrchestration(orchestration), { ...child });
    this.#scheduleSave();
  }

  #refreshStatus(orchestration: AgentOrchestration): void {
    orchestration.updatedAt = new Date().toISOString();
    if (orchestration.children.every((child) => child.status === 'completed')) {
      orchestration.status = 'completed';
    } else if (orchestration.children.some((child) => child.status === 'failed')) {
      orchestration.status = 'failed';
    } else if (orchestration.children.every((child) => isFinalOrchestrationStatus(child.status))) {
      orchestration.status = 'aborted';
    } else if (orchestration.children.some((child) => child.status === 'running')) {
      orchestration.status = 'running';
    } else {
      orchestration.status = 'starting';
    }
  }

  #areChildrenFinal(orchestration: AgentOrchestration, childIds: Set<string>): boolean {
    return orchestration.children
      .filter((child) => childIds.has(child.id))
      .every((child) => isFinalOrchestrationStatus(child.status));
  }

  #nextChatId(): string {
    let candidate = '';
    do {
      candidate = String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
    } while (this.#registry.getChat(candidate));
    return candidate;
  }

  #storePath(): string {
    return path.join(this.#workspaceDir, 'agent-orchestrations.json');
  }

  #scheduleSave(): void {
    if (this.#saveScheduled) return;
    this.#saveScheduled = true;
    queueMicrotask(() => {
      this.#saveScheduled = false;
      this.#saveNow().catch((error) => {
        console.warn('orchestrator: failed to persist state:', error.message);
      });
    });
  }

  async #saveNow(): Promise<void> {
    const snapshot: PersistedOrchestrationSnapshot = {
      version: STORE_VERSION,
      orchestrations: Array.from(this.#orchestrations.values()).map(cloneOrchestration),
    };
    await writeJsonFileAtomic(this.#storePath(), snapshot);
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function normalizeTasks(tasks: unknown): AgentOrchestrationTaskRequest[] {
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks must contain at least one task');
  if (tasks.length > 16) throw new Error('tasks cannot contain more than 16 entries');
  return tasks.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`tasks[${index}] must be an object`);
    const record = raw as Record<string, unknown>;
    const taskName = requireNonEmptyString(record.taskName, `tasks[${index}].taskName`);
    if (!TASK_NAME_RE.test(taskName)) {
      throw new Error(`tasks[${index}].taskName must use lowercase letters, digits, and underscores`);
    }
    const prompt = requireNonEmptyString(record.prompt, `tasks[${index}].prompt`);
    return {
      taskName,
      prompt,
      role: typeof record.role === 'string' && record.role.trim() ? record.role.trim() : undefined,
      model: typeof record.model === 'string' && record.model.trim() ? record.model.trim() : undefined,
      permissionMode: isPermissionMode(record.permissionMode) ? record.permissionMode : undefined,
      thinkingMode: isThinkingMode(record.thinkingMode) ? record.thinkingMode : undefined,
      claudeThinkingMode: isClaudeThinkingMode(record.claudeThinkingMode) ? record.claudeThinkingMode : undefined,
      ampAgentMode: isAmpAgentMode(record.ampAgentMode) ? record.ampAgentMode : undefined,
    };
  });
}

function clampConcurrency(value: unknown): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_CONCURRENCY_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_CONCURRENCY_LIMIT);
}

function clampWaitTimeout(value: unknown): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_WAIT_TIMEOUT_MS;
  return Math.min(Math.max(parsed, 0), MAX_WAIT_TIMEOUT_MS);
}

function runOptionsForTask(
  parent: { permissionMode?: unknown; thinkingMode?: unknown; claudeThinkingMode?: unknown; ampAgentMode?: unknown },
  task: AgentOrchestrationTaskRequest,
): RunAgentTurnOptions {
  return {
    model: task.model,
    permissionMode: normalizePermissionMode(task.permissionMode ?? parent.permissionMode),
    thinkingMode: normalizeThinkingMode(task.thinkingMode ?? parent.thinkingMode),
    claudeThinkingMode: normalizeClaudeThinkingMode(task.claudeThinkingMode ?? parent.claudeThinkingMode),
    ampAgentMode: normalizeAmpAgentMode(task.ampAgentMode ?? parent.ampAgentMode),
  };
}

function buildChildPrompt(parentChatId: string, task: AgentOrchestrationTaskRequest): string {
  const roleLine = task.role ? `Role: ${task.role}\n` : '';
  return `You are a Garcon-orchestrated subagent.
Parent chat: ${parentChatId}
Task name: ${task.taskName}
${roleLine}Work only on this task. Return a concise final answer with the concrete result, changed files if any, and remaining risks.

${task.prompt}`;
}

async function runBounded<T>(
  items: T[],
  concurrencyLimit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrencyLimit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function latestPreviewText(messages: unknown[]): string | null {
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    if (record.type !== 'assistant-message' && record.type !== 'error-message') continue;
    if (typeof record.content === 'string' && record.content.trim()) return record.content.trim();
  }
  return null;
}

function normalizePersistedOrchestration(raw: AgentOrchestration): AgentOrchestration {
  const children = Array.isArray(raw.children) ? raw.children : [];
  const orchestration: AgentOrchestration = {
    id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
    parentChatId: typeof raw.parentChatId === 'string' ? raw.parentChatId : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    status: normalizeStatus(raw.status),
    concurrencyLimit: clampConcurrency(raw.concurrencyLimit),
    children: children.map((child) => ({
      ...child,
      id: typeof child.id === 'string' ? child.id : crypto.randomUUID(),
      parentChatId: typeof child.parentChatId === 'string' ? child.parentChatId : raw.parentChatId,
      childChatId: typeof child.childChatId === 'string' ? child.childChatId : '',
      taskName: typeof child.taskName === 'string' ? child.taskName : 'task',
      prompt: typeof child.prompt === 'string' ? child.prompt : '',
      status: normalizeStatus(child.status),
      createdAt: typeof child.createdAt === 'string' ? child.createdAt : new Date().toISOString(),
      updatedAt: typeof child.updatedAt === 'string' ? child.updatedAt : new Date().toISOString(),
    })),
  };
  return orchestration;
}

function normalizeStatus(value: unknown): AgentOrchestrationChildStatus {
  if (value === 'starting' || value === 'running' || value === 'completed' || value === 'failed' || value === 'aborted') {
    return value;
  }
  return 'failed';
}

function cloneOrchestration(orchestration: AgentOrchestration): AgentOrchestration {
  return {
    ...orchestration,
    children: orchestration.children.map((child) => ({ ...child })),
  };
}
