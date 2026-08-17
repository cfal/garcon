import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationDirectories } from './integration-fixture.js';

export interface PersistedChatBinding extends Record<string, unknown> {
  readonly agentId: string;
  readonly agentSessionId: string | null;
  readonly modelEndpointId: string | null;
  readonly nativeSession: {
    readonly value: Record<string, unknown>;
  } | null;
}

interface PersistedRegistry {
  readonly sessions: Record<string, PersistedChatBinding>;
}

export async function waitForPersistedChat<T>(input: {
  readonly directories: IntegrationDirectories;
  readonly chatId: string;
  readonly select: (chat: PersistedChatBinding) => T | null;
  readonly timeoutMs?: number;
  readonly timeoutMessage: string;
}): Promise<T> {
  const deadline = Date.now() + (input.timeoutMs ?? 5_000);
  const registryPath = join(input.directories.workspace, 'chats.json');

  while (Date.now() < deadline) {
    let raw: string;
    try {
      raw = await readFile(registryPath, 'utf8');
    } catch (error) {
      if (!hasNodeErrorCode(error, 'ENOENT')) throw error;
      await Bun.sleep(20);
      continue;
    }

    const registry = parsePersistedRegistry(JSON.parse(raw));
    const chat = registry.sessions[input.chatId];
    if (chat) {
      const selected = input.select(chat);
      if (selected !== null) return selected;
    }
    await Bun.sleep(20);
  }

  throw new Error(input.timeoutMessage);
}

export async function waitForPersistedNativeSession(input: {
  readonly directories: IntegrationDirectories;
  readonly chatId: string;
  readonly agentId: string;
  readonly timeoutMs?: number;
}): Promise<PersistedChatBinding> {
  return waitForPersistedChat({
    directories: input.directories,
    chatId: input.chatId,
    timeoutMs: input.timeoutMs,
    timeoutMessage: `Chat ${input.chatId} did not persist its ${input.agentId} native session.`,
    select: (chat) => {
      if (chat.agentId !== input.agentId) {
        throw new Error(`Chat ${input.chatId} is not a ${input.agentId} chat.`);
      }
      if (
        typeof chat.agentSessionId === 'string'
        && chat.agentSessionId.length > 0
        && chat.nativeSession
      ) {
        return chat;
      }
      return null;
    },
  });
}

function parsePersistedRegistry(value: unknown): PersistedRegistry {
  if (!isRecord(value) || !isRecord(value.sessions)) {
    throw new TypeError('Persisted chat registry is invalid.');
  }

  const sessions: Record<string, PersistedChatBinding> = {};
  for (const [chatId, chat] of Object.entries(value.sessions)) {
    sessions[chatId] = parsePersistedChatBinding(chatId, chat);
  }
  return { sessions };
}

function parsePersistedChatBinding(chatId: string, value: unknown): PersistedChatBinding {
  if (!isRecord(value) || typeof value.agentId !== 'string' || value.agentId.length === 0) {
    throw new TypeError(`Persisted chat ${chatId} is invalid.`);
  }

  const agentSessionId = parseNullableString(value.agentSessionId, chatId, 'agentSessionId');
  const modelEndpointId = parseNullableString(value.modelEndpointId, chatId, 'modelEndpointId');
  let nativeSession: PersistedChatBinding['nativeSession'] = null;
  if (value.nativeSession !== undefined && value.nativeSession !== null) {
    if (!isRecord(value.nativeSession) || !isRecord(value.nativeSession.value)) {
      throw new TypeError(`Persisted chat ${chatId} has an invalid nativeSession.`);
    }
    nativeSession = {
      ...value.nativeSession,
      value: value.nativeSession.value,
    };
  }

  return {
    ...value,
    agentId: value.agentId,
    agentSessionId,
    modelEndpointId,
    nativeSession,
  };
}

function parseNullableString(
  value: unknown,
  chatId: string,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  throw new TypeError(`Persisted chat ${chatId} has an invalid ${field}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === code;
}
