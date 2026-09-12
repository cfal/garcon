import { resolveClaudeModel } from './model-context.js';

export function buildClaudeCLIEnvironment(model = '', overrides?: Record<string, string>) {
  const { CLAUDECODE, ...inherited } = process.env;
  const env = { ...inherited, ...overrides };
  if (resolveClaudeModel(model).autoCompactWindow !== null) {
    // Claude gives this variable precedence over --autocompact; an explicit model cap wins.
    // https://code.claude.com/docs/en/model-config#set-the-auto-compact-window
    delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
  }
  return env;
}
