import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationDirectories } from './integration-fixture.js';

export async function waitForPersistedNativeSession(input: {
  readonly directories: IntegrationDirectories;
  readonly chatId: string;
  readonly agentId: string;
  readonly timeoutMs?: number;
}): Promise<Record<string, unknown>> {
  const deadline = Date.now() + (input.timeoutMs ?? 5_000);

  while (Date.now() < deadline) {
    try {
      const registry = JSON.parse(
        await readFile(join(input.directories.workspace, 'chats.json'), 'utf8'),
      ) as { sessions?: Record<string, Record<string, unknown>> };
      const chat = registry.sessions?.[input.chatId];
      if (chat?.agentId !== undefined && chat.agentId !== input.agentId) {
        throw new Error(`Chat ${input.chatId} is not a ${input.agentId} chat.`);
      }
      if (
        typeof chat?.agentSessionId === 'string'
        && chat.agentSessionId.length > 0
        && chat.nativeSession
        && typeof chat.nativeSession === 'object'
      ) {
        return chat;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes(`is not a ${input.agentId} chat`)) {
        throw error;
      }
    }
    await Bun.sleep(20);
  }

  throw new Error(`Chat ${input.chatId} did not persist its ${input.agentId} native session.`);
}
