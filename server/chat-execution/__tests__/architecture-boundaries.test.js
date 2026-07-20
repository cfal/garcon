import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function productionFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : productionFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('chat execution architecture boundaries', () => {
  test('keeps filesystem IO out of chat execution', () => {
    for (const file of productionFiles('server/chat-execution')) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"](?:node:)?fs['"]/);
    }
  });

  test('keeps the per-chat execution lock inside the coordinator', () => {
    for (const file of productionFiles('server/chat-execution')) {
      const source = readFileSync(file, 'utf8');
      if (file.endsWith('chat-execution-coordinator.ts')) continue;
      expect(source, file).not.toContain('KeyedPromiseLock');
    }
  });

  test('keeps command handlers out of reservation and stored-receipt internals', () => {
    for (const file of [
      'server/commands/chat-command-service.ts',
      'server/routes/chats.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/reserveDirect|releaseDirect|triggerDrain|appliedCommands/);
    }
  });
});
