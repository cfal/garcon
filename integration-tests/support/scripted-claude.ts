// Runs the real pinned Claude Code CLI with its model swapped for a script. ANTHROPIC_BASE_URL
// points the CLI at FakeClaudeModel, so CLI behavior stays real while every model choice is
// deterministic and no credential is required.

import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { FakeClaudeModel } from './fake-claude-model.js';
import { CLAUDE_BINARY } from './live-claude.js';

export interface ScriptedClaudeTestEnvironment {
  readonly model: FakeClaudeModel;
  readonly serverEnvironment: Record<string, string>;
  dispose(): void;
}

export async function startScriptedClaudeTestEnvironment(): Promise<ScriptedClaudeTestEnvironment> {
  await access(CLAUDE_BINARY, constants.X_OK);
  const model = FakeClaudeModel.start();
  return {
    model,
    serverEnvironment: {
      ANTHROPIC_API_KEY: 'garcon-scripted-claude-key',
      ANTHROPIC_AUTH_TOKEN: '',
      ANTHROPIC_BASE_URL: model.baseUrl,
      CLAUDE_BINARY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    dispose() {
      model.stop();
    },
  };
}
