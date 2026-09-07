import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const LIVE_APP_SERVER_FILES = [
  'server-agents/codex/src/agents/codex/app-server/runtime.ts',
  'server-agents/codex/src/agents/codex/app-server/turn-item-ledger.ts',
];

describe('Codex live app-server architecture', () => {
  test('[TLV5-L10.01-CODEX-STATIC-01] does not load complete native history during live execution', () => {
    for (const file of LIVE_APP_SERVER_FILES) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from ['"][^'"]*history-loader/);
      expect(source, file).not.toContain('loadCodexChatMessages');
    }
  });
});
