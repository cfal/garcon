import { appendFileSync } from 'node:fs';
import type { LiveClaudeContextObservation } from './live-claude-protocol-probe.js';

const realBinary = requiredEnvironment('GARCON_LIVE_CLAUDE_REAL_BINARY');
const startedPath = requiredEnvironment('GARCON_LIVE_CLAUDE_STARTED_PATH');
const terminalReasonPath = requiredEnvironment('GARCON_LIVE_CLAUDE_TERMINAL_REASON_PATH');
const interruptReceiptPath = requiredEnvironment('GARCON_LIVE_CLAUDE_INTERRUPT_RECEIPT_PATH');
const contextPath = process.env.GARCON_LIVE_CLAUDE_CONTEXT_PATH;
const invalidateContextUsage = process.env.GARCON_LIVE_CLAUDE_INVALID_CONTEXT === '1';
const args = process.argv.slice(2);
if (process.env.GARCON_LIVE_CLAUDE_FLAG_ENV && !args.includes('--version')) {
  args.push('--settings', JSON.stringify({ env: JSON.parse(process.env.GARCON_LIVE_CLAUDE_FLAG_ENV) }));
}
const child = Bun.spawn([realBinary, ...args], {
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

function observe(line: string): string {
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return line;
    message = parsed;
  } catch {
    return line;
  }
  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    recordContext({ type: 'compact-boundary', processId: child.pid });
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
  const control = message.response;
  if (
    message.type !== 'control_response'
    || !isRecord(control)
    || control.subtype !== 'success'
    || !isRecord(control.response)
  ) return line;

  const receipt = control.response;
  if (Array.isArray(receipt.cancelled) || Array.isArray(receipt.still_queued)) {
    appendFileSync(
      interruptReceiptPath,
      `${JSON.stringify({
        type: 'interrupt-receipt',
        cancelledCount: Array.isArray(receipt.cancelled) ? receipt.cancelled.length : 0,
        stillQueuedCount: Array.isArray(receipt.still_queued) ? receipt.still_queued.length : 0,
      })}\n`,
    );
  }
  const processId = child.pid;
  if (Array.isArray(receipt.sources)) {
    const flags = receipt.sources.find(source => isRecord(source) && source.source === 'flagSettings');
    const settings = isRecord(flags?.settings) ? flags.settings : {};
    recordContext({
      type: 'flag-environment', processId,
      keys: isRecord(settings.env) ? Object.keys(settings.env) : [],
    });
  }
  if (
    typeof receipt.model === 'string'
    && typeof receipt.rawMaxTokens === 'number'
    && typeof receipt.autocompactSource === 'string'
  ) {
    recordContext({
      type: 'context-window', processId, model: receipt.model,
      source: receipt.autocompactSource, window: receipt.rawMaxTokens,
    });
    if (invalidateContextUsage) {
      return JSON.stringify({
        ...message,
        response: { ...control, response: { ...receipt, rawMaxTokens: 0 } },
      });
    }
  }
  return line;
}

function recordContext(observation: LiveClaudeContextObservation): void {
  if (contextPath) appendFileSync(contextPath, `${JSON.stringify(observation)}\n`);
}

for await (const chunk of child.stdout) {
  if (!invalidateContextUsage) process.stdout.write(chunk);
  pending += decoder.decode(chunk, { stream: true });
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) {
    const forwarded = observe(line);
    if (invalidateContextUsage) process.stdout.write(`${forwarded}\n`);
  }
}
pending += decoder.decode();
if (pending) {
  const forwarded = observe(pending);
  if (invalidateContextUsage) process.stdout.write(forwarded);
}
process.exitCode = await child.exited;
