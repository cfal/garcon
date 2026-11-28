import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const trace = process.env.SYNTHETIC_CODEX_TRACE;
const mode = process.env.SYNTHETIC_CODEX_MODE;
if (mode === 'stubborn') process.on('SIGTERM', () => {});
if (trace) appendFileSync(trace, JSON.stringify({ argv: process.argv.slice(2) }) + '\n');
const input = createInterface({ input: process.stdin });
const write = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');

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
    case 'stall':
      setTimeout(() => write({ id, result: {} }), 80);
      break;
    case 'turn/steer':
      if (mode === 'exit') process.exit(7);
      if (mode === 'delay') setTimeout(() => write({ id, result: { turnId: params.expectedTurnId } }), 80);
      else write({ id, result: { turnId: params.expectedTurnId } });
      break;
  }
}
if (mode === 'retry' && trace) appendFileSync(trace, '{"closed":true}\n');
if (mode === 'stubborn') setInterval(() => {}, 10_000);
