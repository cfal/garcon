import { expect, test } from 'bun:test';
import { request as httpRequest } from 'node:http';
import { discoverRuntime } from '../../../cli/discovery.js';
import { CLI_CONTRACT_HEADER, CLI_OPERATIONS, type CliOperation } from '../../../common/cli-contracts.js';
import { CLI_SERVER_INSTANCE_HEADER } from '../../../common/server-runtime.js';
import { TICKET_LIMITS } from '../../../common/tickets.js';
import { withCliFixture } from '../../support/cli-fixture.js';

test('direct and forwarded CLI reject invalid versioned requests before effects', async () => {
  await withCliFixture('cli-contract-validation', async fixture => {
    const connections = [await discoverRuntime({ configDir: fixture.dirs.config, runtime: 'controller' })];
    if (fixture.client.executorId !== 'local') {
      connections.push(await discoverRuntime({ configDir: fixture.executionDirs.config, runtime: 'executor' }));
    }
    const settings = await fixture.client.get('/api/v1/app/settings');
    const cases: readonly { operation: CliOperation; body?: unknown; query?: string; status: number; code: string }[] = [
      { operation: 'PUT /api/v1/app/settings', body: { ui: { chatTitle: { enabled: true } } }, status: 403, code: 'CLI_ACCESS_DENIED' },
      { operation: 'GET /api/v1/models', status: 400, code: 'VALIDATION_FAILED' },
      { operation: 'GET /api/v1/models', query: '?executorId=local&executorId=local', status: 400, code: 'VALIDATION_FAILED' },
      { operation: 'POST /api/v1/chats/start', body: {}, status: 400, code: 'VALIDATION_FAILED' },
      { operation: 'POST /api/v1/chats/lookup-native-session', body: {}, status: 400, code: 'VALIDATION_FAILED' },
      { operation: 'POST /api/v1/tickets/project-default', body: { cwd: fixture.dirs.project }, status: 400, code: 'VALIDATION_FAILED' },
      { operation: 'POST /api/v1/scheduled-prompts', body: { scheduledPrompt: { target: { type: 'new-chat' } } }, status: 400, code: 'VALIDATION_FAILED' },
    ];
    for (const connection of connections) {
      for (const item of cases) {
        const [method, path] = item.operation.split(' ');
        const definition = CLI_OPERATIONS[item.operation][1];
        const response = await fetch(`${connection.baseUrl}${path}${item.query ?? ''}`, {
          method,
          headers: { Authorization: `Bearer ${connection.localCapability}`, 'Content-Type': 'application/json',
            [CLI_SERVER_INSTANCE_HEADER]: connection.instanceId, [CLI_CONTRACT_HEADER]: `${definition.name}@1` },
          body: item.body === undefined ? undefined : JSON.stringify(item.body),
        });
        expect(response.status, `${connection.selector.runtime}: ${item.operation}`).toBe(item.status);
        expect(await response.json()).toMatchObject({ errorCode: item.code });
      }
    }
    expect(await fixture.client.get('/api/v1/app/settings')).toEqual(settings);
  });
}, 30_000);

test('direct CLI ticket upload limits reject unfinished bodies', async () => {
  await withCliFixture('cli-ticket-upload-limits', async fixture => {
    const connection = await discoverRuntime({ configDir: fixture.dirs.config, runtime: 'controller' });
    for (const operation of ['mutate', 'project-default']) {
      for (const declared of [true, false]) {
        const result = Promise.withResolvers<{ status: number; cacheControl?: string; body: unknown }>();
        const upload = httpRequest(`${connection.baseUrl}/api/v1/tickets/${operation}`, {
          method: 'POST', headers: { Authorization: `Bearer ${connection.localCapability}`, 'Content-Type': 'application/json',
            [CLI_SERVER_INSTANCE_HEADER]: connection.instanceId,
            [CLI_CONTRACT_HEADER]: `cli.tickets.${operation === 'mutate' ? 'mutate' : 'projectDefault'}@1`,
            ...(declared ? { 'Content-Length': String(TICKET_LIMITS.requestBytes + 1) } : {}) },
        }, response => {
          let text = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { text += chunk; });
          response.once('error', result.reject);
          response.once('end', () => {
            try { result.resolve({ status: response.statusCode!, cacheControl: response.headers['cache-control'], body: JSON.parse(text) }); }
            catch (error) { result.reject(error); }
          });
        });
        upload.once('error', result.reject);
        upload.setTimeout(5_000, () => upload.destroy(new Error('Ticket upload was not rejected before EOF')));
        try {
          upload.write(Buffer.alloc(declared ? 1 : TICKET_LIMITS.requestBytes + 1, 32));
          expect(await result.promise).toMatchObject({ status: 413, cacheControl: 'no-store', body: { errorCode: 'TICKET_REQUEST_TOO_LARGE' } });
        } finally { upload.destroy(); }
      }
    }
  });
}, 30_000);
