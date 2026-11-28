import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const trace = process.env.SYNTHETIC_CODEX_TRACE;
const mode = process.env.SYNTHETIC_CODEX_MODE;
const nativePath = process.env.SYNTHETIC_CODEX_NATIVE_PATH;
if (mode === 'stubborn') process.on('SIGTERM', () => {});
if (trace) appendFileSync(trace, JSON.stringify({ argv: process.argv.slice(2) }) + '\n');
const input = createInterface({ input: process.stdin });
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
let threadListAttempts = 0;
let utilityRequestId: number | undefined;
let utilityResponses = 0;

for await (const line of input) {
  if (trace) appendFileSync(trace, line + '\n');
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case 'initialize':
      if (mode === 'retry' && id === 1) {
        write({ id, error: { code: -32603, message: 'Synthetic initialization failure' } });
        break;
      }
      write({ id, result: {
        userAgent: mode === 'old' ? 'codex/0.170.0' : 'codex/0.171.0',
        codexHome: '/synthetic/codex', platformFamily: 'unix', platformOs: 'linux',
      } });
      break;
    case 'ping':
      write({ id, result: { pong: true } });
      break;
    case 'skills/list':
      write({ id, result: { data: [{ skills: params.cwds[0] === '/empty' ? [] : [
        { name: 'verify', path: '/synthetic/verify', description: 'Synthetic skill' },
        { name: 'ignored', path: '/synthetic/disabled', enabled: false },
      ] }] } });
      break;
    case 'thread/list': {
      threadListAttempts++;
      if (mode === 'utility-exit') process.exit(8);
      if (mode === 'utility-overload' && threadListAttempts < 3) {
        write({ id, error: { code: -32001, message: 'Synthetic overload' } });
        break;
      }
      if (mode === 'utility-error' && threadListAttempts === 1) {
        write({ id, error: { code: -32603, message: 'Synthetic discovery failed' } });
        break;
      }
      const hasPath = nativePath && existsSync(nativePath);
      const data = hasPath ? [{ id: 'thread', path: nativePath }] : [];
      if (mode === 'utility-server-requests') {
        utilityRequestId = id;
        process.stderr.write('synthetic private stderr\n');
        process.stdout.write('invalid native output with synthetic private content\n');
        write({ id: 'unsupported', method: 'synthetic/unknown' });
        write({ id: 101, method: 'item/commandExecution/requestApproval', params: {
          threadId: 'thread', turnId: 'turn', kind: 'writeStdin',
        } });
      } else if (mode === 'utility-overload' && params.cursor === null) {
        write({ id, result: { data: [], nextCursor: 'second-page' } });
      } else {
        write({ id, result: { data, nextCursor: null } });
      }
      break;
    }
    case undefined:
      if (mode === 'utility-server-requests' && (id === 'unsupported' || id === 101) && ++utilityResponses === 2) {
        write({ id: utilityRequestId, result: { data: [], nextCursor: null } });
      }
      break;
    case 'send-events':
      process.stdout.write('invalid native output with synthetic private content\n');
      write({ method: 'one', params: { value: 1 } });
      write({ method: 'two', params: { value: 2 } });
      write({ id: 'string-id', method: 'approve', params: { synthetic: true } });
      write({ id, result: {} });
      break;
    case 'bad':
      write({ id, error: { code: -32001, message: 'Synthetic RPC error', data: { reason: 'synthetic' } } });
      break;
    case 'thread/settings/update': {
      if (mode === 'settings-failure') {
        write({ id, error: { code: -32603, message: 'Synthetic settings failure' } });
        break;
      }
      if (mode !== 'settings-timeout') {
        write({ method: 'thread/settings/updated', params: {
          threadId: params.threadId,
          threadSettings: {
            model: params.model, approvalPolicy: params.approvalPolicy,
            approvalsReviewer: params.approvalsReviewer, sandboxPolicy: params.sandboxPolicy,
            serviceTier: 'default', effort: params.effort ?? 'medium',
          },
        } });
      }
      write({ id, result: {} });
      break;
    }
    case 'stall':
      setTimeout(() => write({ id, result: {} }), 80);
      break;
    case 'turn/steer':
      if (mode === 'exit') process.exit(7);
      if (mode === 'steer-mismatch') {
        write({ id, error: { code: -32602, message: 'expected active turn id `turn` but found `next`' } });
        break;
      }
      if (mode === 'delay') setTimeout(() => write({ id, result: { turnId: params.expectedTurnId } }), 80);
      else write({ id, result: { turnId: params.expectedTurnId } });
      break;
  }
}
if (mode === 'retry' && trace) appendFileSync(trace, '{"closed":true}\n');
if (mode === 'stubborn') setInterval(() => {}, 10_000);
