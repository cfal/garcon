import { appendFileSync } from 'node:fs';

const realBinary = requiredEnvironment('GARCON_LIVE_CLAUDE_REAL_BINARY');
const startedPath = requiredEnvironment('GARCON_LIVE_CLAUDE_STARTED_PATH');
const terminalReasonPath = requiredEnvironment('GARCON_LIVE_CLAUDE_TERMINAL_REASON_PATH');
const child = Bun.spawn([realBinary, ...process.argv.slice(2)], {
  env: process.env,
  stdin: 'inherit',
  stdout: 'pipe',
  stderr: 'inherit',
});
const decoder = new TextDecoder();
let pending = '';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Live Claude protocol forwarder requires ${name}.`);
  return value;
}

function observe(line: string): void {
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    message = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  if (
    message.type === 'command_lifecycle'
    && message.state === 'started'
    && typeof message.command_uuid === 'string'
  ) {
    appendFileSync(
      startedPath,
      `${JSON.stringify({ type: 'started', commandUuid: message.command_uuid })}\n`,
    );
  }
  if (
    message.type === 'result'
    && (message.terminal_reason === 'aborted_streaming' || message.terminal_reason === 'aborted_tools')
    && typeof message.user_message_uuid === 'string'
  ) {
    appendFileSync(
      terminalReasonPath,
      `${JSON.stringify({
        type: 'terminal',
        reason: message.terminal_reason,
        userMessageUuid: message.user_message_uuid,
      })}\n`,
    );
  }
}

for await (const chunk of child.stdout) {
  process.stdout.write(chunk);
  pending += decoder.decode(chunk, { stream: true });
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) observe(line);
}
pending += decoder.decode();
if (pending) observe(pending);
process.exitCode = await child.exited;
