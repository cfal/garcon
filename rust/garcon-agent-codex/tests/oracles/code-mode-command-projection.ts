import {
  codexCodeModeBashToolId,
  codexCodeModeResultToolId,
  createCodexCodeModeBashMessages,
  rewriteCodexCodeModeCommandPrefix,
} from '../../../../server-agents/codex/src/agents/codex/code-mode-command-projection.ts';

export { codexCodeModeBashToolId, rewriteCodexCodeModeCommandPrefix };

export function projectBashMessages(timestamp: string, outerCallId: string, commands: string[]) {
  const projection = { commands };
  return {
    messages: createCodexCodeModeBashMessages(timestamp, outerCallId, projection)
      .map((message) => ({ ...message })),
    resultId: codexCodeModeResultToolId(outerCallId, projection),
  };
}
