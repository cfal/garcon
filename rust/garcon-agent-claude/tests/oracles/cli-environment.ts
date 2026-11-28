import { buildClaudeCLIEnvironment } from '../../../../server-agents/claude/src/agents/claude/cli-environment.ts';

export function buildWithEnvironment(model: string, parent: Record<string, string>, overrides?: Record<string, string>) {
  const previous = process.env;
  process.env = { ...parent };
  try {
    return buildClaudeCLIEnvironment(model, overrides);
  } finally {
    process.env = previous;
  }
}
