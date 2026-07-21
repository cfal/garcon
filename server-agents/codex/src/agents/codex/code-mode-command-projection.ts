import { BashToolUseMessage } from '@garcon/common/chat-types';
import {
  projectCodexCodeModeCommands,
  type CodexCodeModeCommandProjection,
} from './code-mode-command-parser.js';

export { projectCodexCodeModeCommands, type CodexCodeModeCommandProjection };

export function codexCodeModeBashToolId(
  outerCallId: string,
  commandIndex: number,
): string {
  return `codex-code-mode:${outerCallId}:${commandIndex}`;
}

export function codexCodeModeResultToolId(
  outerCallId: string,
  projection: CodexCodeModeCommandProjection,
): string {
  return codexCodeModeBashToolId(outerCallId, projection.commands.length - 1);
}

export function createCodexCodeModeBashMessages(
  timestamp: string,
  outerCallId: string,
  projection: CodexCodeModeCommandProjection,
): BashToolUseMessage[] {
  return projection.commands.map((command, index) => (
    new BashToolUseMessage(timestamp, codexCodeModeBashToolId(outerCallId, index), command)
  ));
}

export function rewriteCodexCodeModeCommandPrefix(commands: readonly string[]): string {
  const calls = commands
    .map((command) => `  tools.exec_command({ cmd: ${JSON.stringify(command)} })`)
    .join(',\n');
  return [
    'const results = await Promise.all([',
    calls,
    ']);',
    'for (const result of results) text(result.output);',
  ].join('\n');
}
