import { appendFileSync } from 'node:fs';

const realBinary = requiredEnvironment('GARCON_LIVE_CODEX_REAL_BINARY');
const approvalPath = requiredEnvironment('GARCON_LIVE_CODEX_APPROVAL_PATH');
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
  if (!value) throw new Error(`Live Codex protocol forwarder requires ${name}.`);
  return value;
}

function isApprovalMethod(value: unknown): value is string {
  return typeof value === 'string' && [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'execCommandApproval',
    'applyPatchApproval',
  ].includes(value);
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
  if (!isApprovalMethod(message.method) || !['number', 'string'].includes(typeof message.id)) {
    return;
  }
  appendFileSync(
    approvalPath,
    `${JSON.stringify({ type: 'approval-request', method: message.method })}\n`,
  );
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
