import { appendFileSync, existsSync } from 'node:fs';

const realBinary = requiredEnvironment('GARCON_REUSED_PERMISSION_CLAUDE_BINARY');
const requestLogPath = requiredEnvironment('GARCON_REUSED_PERMISSION_REQUEST_LOG');
const callbackLogPath = requiredEnvironment('GARCON_REUSED_PERMISSION_CALLBACK_LOG');
const cancelReleasePath = requiredEnvironment('GARCON_REUSED_PERMISSION_CANCEL_RELEASE');
const secondCommand = requiredEnvironment('GARCON_REUSED_PERMISSION_SECOND_COMMAND');
const secondToolUseId = requiredEnvironment('GARCON_REUSED_PERMISSION_SECOND_TOOL_USE_ID');

const child = Bun.spawn([realBinary, ...process.argv.slice(2)], {
  env: { ...process.env, CLAUDE_BINARY: realBinary },
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});

let reusedRequestId: string | null = null;
let cancelPoll: ReturnType<typeof setInterval> | null = null;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Claude permission proxy requires ${name}.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function appendLog(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function emitProviderLine(line: string): void {
  process.stdout.write(`${line}\n`);

  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return;
    message = parsed;
  } catch {
    return;
  }

  const request = isRecord(message.request) ? message.request : null;
  if (
    reusedRequestId !== null
    || message.type !== 'control_request'
    || request?.subtype !== 'can_use_tool'
    || request.tool_name !== 'Bash'
    || typeof message.request_id !== 'string'
  ) {
    return;
  }

  reusedRequestId = message.request_id;
  const firstInput = isRecord(request.input) ? request.input : {};
  appendLog(requestLogPath, {
    occurrence: 'first',
    requestId: reusedRequestId,
    command: firstInput.command,
    toolUseId: request.tool_use_id,
  });

  const duplicate = {
    ...message,
    request: {
      ...request,
      input: { ...firstInput, command: secondCommand },
      tool_use_id: secondToolUseId,
    },
  };
  process.stdout.write(`${JSON.stringify(duplicate)}\n`);
  appendLog(requestLogPath, {
    occurrence: 'second',
    requestId: reusedRequestId,
    command: secondCommand,
    toolUseId: secondToolUseId,
  });

  cancelPoll = setInterval(() => {
    if (!reusedRequestId || !existsSync(cancelReleasePath)) return;
    if (cancelPoll) clearInterval(cancelPoll);
    cancelPoll = null;
    process.stdout.write(`${JSON.stringify({
      type: 'control_cancel_request',
      request_id: reusedRequestId,
    })}\n`);
    appendLog(requestLogPath, {
      occurrence: 'first',
      requestId: reusedRequestId,
      terminal: 'cancelled',
    });
  }, 10);
  cancelPoll.unref();
}

function observeClientLine(line: string): void {
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed)) return;
    message = parsed;
  } catch {
    return;
  }
  const response = isRecord(message.response) ? message.response : null;
  if (
    message.type !== 'control_response'
    || response?.request_id !== reusedRequestId
  ) {
    return;
  }
  appendLog(callbackLogPath, {
    requestId: response.request_id,
    response: response.response,
    subtype: response.subtype,
  });
}

async function pumpClientInput(): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of Bun.stdin.stream()) {
    child.stdin.write(chunk);
    child.stdin.flush();
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) observeClientLine(line);
  }
  pending += decoder.decode();
  if (pending) observeClientLine(pending);
  child.stdin.end();
}

async function pumpProviderOutput(): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of child.stdout) {
    pending += decoder.decode(chunk, { stream: true });
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) emitProviderLine(line);
  }
  pending += decoder.decode();
  if (pending) emitProviderLine(pending);
}

async function pumpProviderError(): Promise<void> {
  for await (const chunk of child.stderr) process.stderr.write(chunk);
}

const input = pumpClientInput().catch((error: unknown) => {
  console.error(error);
  child.kill();
});
const output = Promise.all([pumpProviderOutput(), pumpProviderError()]);
const exitCode = await child.exited;
if (cancelPoll) clearInterval(cancelPoll);
await output;
void input;
process.exit(exitCode);
