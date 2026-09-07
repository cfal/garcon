import { appendFileSync } from 'node:fs';

const realBinary = requiredEnvironment('GARCON_LIVE_CLAUDE_REAL_BINARY');
const startedPath = requiredEnvironment('GARCON_LIVE_CLAUDE_STARTED_PATH');
const terminalReasonPath = requiredEnvironment('GARCON_LIVE_CLAUDE_TERMINAL_REASON_PATH');
const interruptReceiptPath = requiredEnvironment('GARCON_LIVE_CLAUDE_INTERRUPT_RECEIPT_PATH');
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  ) {
    appendFileSync(
      terminalReasonPath,
      `${JSON.stringify({
        type: 'terminal',
        reason: message.terminal_reason,
        userMessageUuid:
          typeof message.user_message_uuid === 'string' ? message.user_message_uuid : null,
      })}\n`,
    );
  }
  const control = isRecord(message.response) ? message.response : null;
  const receipt = control?.subtype === 'success' && isRecord(control.response)
    ? control.response
    : null;
  if (
    message.type === 'control_response'
    && receipt
    && (Array.isArray(receipt.cancelled) || Array.isArray(receipt.still_queued))
  ) {
    appendFileSync(
      interruptReceiptPath,
      `${JSON.stringify({
        type: 'interrupt-receipt',
        cancelledCount: Array.isArray(receipt.cancelled) ? receipt.cancelled.length : 0,
        stillQueuedCount: Array.isArray(receipt.still_queued) ? receipt.still_queued.length : 0,
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
