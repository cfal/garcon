import { describe, expect, mock, spyOn, test } from 'bun:test';
import { MAX_NODE_ENROLLMENT_EXCHANGE_BYTES, NODE_ENROLLMENT_TIMEOUT_MS, type NodeEnrollmentRequest, type NodeEnrollmentIssueRequest } from '../../../common/execution-node-config.js';
import type { NodeEnrollmentService } from '../../execution-nodes/enrollment.js';
import { NodeEnrollmentTransport } from '../../execution-nodes/trust.js';
import { isNoAuthHandler } from '../../lib/http-route.js';
import { DomainError } from '../../lib/domain-error.js';
import type { ServerPrincipal } from '../../lib/http-route-types.js';
import type { RequestIpServer } from '../../lib/rate-limit.js';
import { AtomicJsonWriteError } from '../../lib/json-file-store.js';
import {
  createNodeEnrollmentRoutes, MAX_CONCURRENT_NODE_ENROLLMENTS, MAX_NODE_ENROLLMENTS_PER_MINUTE,
  MAX_CONCURRENT_NODE_ENROLLMENTS_PER_PEER, MAX_NODE_ENROLLMENTS_PER_PEER_PER_MINUTE,
} from '../execution-node-enrollment.js';

const body: NodeEnrollmentRequest = { version: 1, nodeId: 'node', controllerId: 'controller', token: `enroll.token.${'A'.repeat(43)}` };
const path = '/api/v1/execution-nodes/enroll';
const url = new URL(`https://controller.test${path}`);
const request = (input: BodyInit = JSON.stringify(body)) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input });
const peer = (address: string): RequestIpServer => ({ requestIP: () => ({ address }) });

function fixture() {
  let now = 0;
  const enrollment = {
    issue: mock(async (input: NodeEnrollmentIssueRequest, _principal: ServerPrincipal | null) => ({
      ...body, nodeId: input.nodeId, controllerUrl: 'https://controller.test', trust: { kind: 'system-ca' as const },
      expiresAt: '2026-09-10T12:10:00.000Z',
    })),
    enroll: mock(async (request: NodeEnrollmentRequest) => ({ version: 1 as const, controllerId: request.controllerId, nodeId: request.nodeId, credential: `node.node.${'A'.repeat(43)}` })),
  } satisfies Pick<NodeEnrollmentService, 'issue' | 'enroll'>;
  const routes = createNodeEnrollmentRoutes({ enrollment, transport: new NodeEnrollmentTransport({ listenerUsesTls: true }), now: () => now });
  return { routes, route: routes[path]!.POST!, enrollment, advance: () => { now += 60_000; } };
}

describe('node enrollment routes', () => {
  test('marks only token exchange as anonymous and keeps the typed private response', async () => {
    const f = fixture();
    expect(isNoAuthHandler(f.route)).toBe(true);
    expect(isNoAuthHandler(f.routes['/api/v1/execution-nodes/enrollment']!.POST)).toBe(false);
    const response = await f.route(request(), url);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ version: 1, controllerId: 'controller', nodeId: 'node', credential: `node.node.${'A'.repeat(43)}` });
    expect(f.enrollment.enroll).toHaveBeenCalledTimes(1);
    expect(f.enrollment.enroll).toHaveBeenCalledWith(body);
  });

  test('rejects insecure transport, query secrets, and oversized or malformed bodies before exchange', async () => {
    const f = fixture();
    const insecure = new Request('http://controller.test' + path, { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' }, body: '{}' });
    const insecureResponse = await f.route(insecure, new URL(insecure.url));
    expect(insecureResponse.status).toBe(403);
    expect(await insecureResponse.json()).toMatchObject({ errorCode: 'NODE_TLS_REQUIRED' });
    const queryUrl = new URL(url + '?token=synthetic-secret');
    expect((await f.route(request(), queryUrl)).status).toBe(400);
    for (const value of ['{malformed', JSON.stringify({ ...body, extra: true }), 'x'.repeat(MAX_NODE_ENROLLMENT_EXCHANGE_BYTES + 1),
      new Uint8Array([0xc3, 0x28])]) expect((await f.route(request(value), url)).status).toBe(400);
    expect(f.enrollment.enroll).not.toHaveBeenCalled();
  });

  test('forwards administrator issuance and bounds its body independently', async () => {
    const f = fixture();
    const issueUrl = new URL('https://controller.test/api/v1/execution-nodes/enrollment');
    const issue = f.routes[issueUrl.pathname]!.POST!;
    const principal: ServerPrincipal = { mode: 'authenticated', key: 'user', username: 'synthetic', expiresAtMs: Date.now() + 60_000 };
    const input = { nodeId: 'node' };
    const send = (body: string, url = issueUrl) => issue(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }), url, undefined, { principal });
    const response = await send(JSON.stringify(input));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ controllerUrl: 'https://controller.test', trust: { kind: 'system-ca' } });
    expect(f.enrollment.issue).toHaveBeenCalledWith(input, principal);
    for (const body of ['{malformed', ' '.repeat(MAX_NODE_ENROLLMENT_EXCHANGE_BYTES) + JSON.stringify(input),
      JSON.stringify({ ...input, controllerUrl: 'https://unrelated.test' }), JSON.stringify({ ...input, trust: { kind: 'system-ca' } })]) {
      expect((await send(body)).status).toBe(400);
    }
    expect((await send(JSON.stringify(input), new URL(issueUrl + '?token=synthetic'))).status).toBe(400);
    expect(f.enrollment.issue).toHaveBeenCalledTimes(1);
  });

  test('caps active readers, releases cancelled slots, and never admits their tokens', async () => {
    const f = fixture();
    const controllers = Array.from({ length: MAX_CONCURRENT_NODE_ENROLLMENTS }, () => new AbortController());
    const reads = controllers.map(() => Promise.withResolvers<void>());
    const pending = controllers.map((controller, index) => f.route(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: new ReadableStream({ pull() { reads[index]!.resolve(); return new Promise(() => {}); } }),
    }), url, peer(`192.0.2.${index + 1}`)));
    await Promise.all(reads.map((read) => read.promise));
    const rejected = await f.route(request(), url);
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({ retryable: true });
    controllers.forEach((controller) => controller.abort());
    expect((await Promise.all(pending)).every((response) => response.status === 503)).toBe(true);
    expect(f.enrollment.enroll).not.toHaveBeenCalled();
    expect((await f.route(request(), url)).status).toBe(200);
  });

  test('bounds aggregate request starts across physical peers', async () => {
    const f = fixture();
    for (let index = 0; index < MAX_NODE_ENROLLMENTS_PER_MINUTE; index++) {
      expect((await f.route(request('{malformed'), url, peer(`192.0.2.${index + 1}`))).status).toBe(400);
    }
    expect((await f.route(request(), url)).status).toBe(429);
    f.advance();
    expect((await f.route(request(), url)).status).toBe(200);
  });

  test('administrator issuance retains its global rate ceiling without the anonymous peer quota', async () => {
    const f = fixture();
    const issueUrl = new URL('https://controller.test/api/v1/execution-nodes/enrollment');
    const principal: ServerPrincipal = { mode: 'authenticated', key: 'user', username: 'synthetic', expiresAtMs: Date.now() + 60_000 };
    const send = () => f.routes[issueUrl.pathname]!.POST!(new Request(issueUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId: 'node' }),
    }), issueUrl, peer('192.0.2.1'), { principal });
    for (let index = 0; index < MAX_NODE_ENROLLMENTS_PER_MINUTE; index++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    f.advance();
    expect((await send()).status).toBe(200);
  });

  test.each(['rate', 'concurrency'])('anonymous %s exhaustion cannot consume administrator issuance capacity', async (limit) => {
    const f = fixture();
    const controller = new AbortController();
    const pending: Promise<Response>[] = [];
    try {
      if (limit === 'rate') {
        for (let index = 0; index < MAX_NODE_ENROLLMENTS_PER_MINUTE; index++) {
          await f.route(request('{malformed'), url, peer(`192.0.2.${index + 1}`));
        }
      } else {
        const readers = Array.from({ length: MAX_CONCURRENT_NODE_ENROLLMENTS }, () => Promise.withResolvers<void>());
        for (const [index, reader] of readers.entries()) pending.push(Promise.resolve(f.route(new Request(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
          body: new ReadableStream({ pull() { reader.resolve(); return new Promise(() => {}); } }),
        }), url, peer(`192.0.2.${index + 1}`))));
        await Promise.all(readers.map((reader) => reader.promise));
      }
      const issueUrl = new URL('https://controller.test/api/v1/execution-nodes/enrollment');
      const response = await f.routes[issueUrl.pathname]!.POST!(new Request(issueUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{malformed',
      }), issueUrl);
      expect(response.status).toBe(400);
    } finally { controller.abort(); await Promise.all(pending); }
  });

  test('times out stalled bodies and clears the deadline without logging body contents', async () => {
    const f = fixture();
    const timer = spyOn(globalThis, 'setTimeout');
    const clear = spyOn(globalThis, 'clearTimeout');
    try {
      const pending = f.route(request(new ReadableStream()), url);
      const scheduled = timer.mock.calls.find((call) => call[1] === NODE_ENROLLMENT_TIMEOUT_MS)!;
      expect(scheduled).toBeDefined();
      (scheduled[0] as () => void)();
      const response = await pending;
      expect(response.status).toBe(408);
      expect(await response.json()).toMatchObject({ errorCode: 'REQUEST_TIMEOUT' });
      expect(clear).toHaveBeenCalled();
      expect(f.enrollment.enroll).not.toHaveBeenCalled();
      expect((await f.route(request(), url)).status).toBe(200);
    } finally { timer.mockRestore(); clear.mockRestore(); }
  });

  test('sanitizes unknown failures and retains domain errors without retrying exchange', async () => {
    for (const failure of [new Error('synthetic-private-token'), new DomainError('NODE_ENROLLMENT_EXPIRED', 'Enrollment expired', 401)]) {
      const f = fixture();
      f.enrollment.enroll.mockRejectedValue(failure);
      const response = await f.route(request(), url);
      const payload = await response.text();
      expect(payload).not.toContain('synthetic-private-token');
      expect(response.status).toBe(failure instanceof DomainError ? 401 : 503);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(f.enrollment.enroll).toHaveBeenCalledTimes(1);
    }
  });

  test('records body-free diagnostics for untyped failures', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const f = fixture();
      f.enrollment.enroll.mockRejectedValue(new Error('synthetic-private-token'));
      expect((await f.route(request(), url)).status).toBe(503);
      expect(logged).toHaveBeenCalledTimes(1);
      const output = JSON.stringify(logged.mock.calls);
      expect(output).toContain('exchange');
      expect(output).toContain('NODE_PAIRING_UNAVAILABLE');
      expect(output).not.toContain('synthetic-private-token');
      expect(output).not.toContain(body.token);
    } finally { logged.mockRestore(); }
  });

  test('one peer cannot monopolize active exchange slots', async () => {
    const f = fixture();
    const cancellation = new AbortController();
    const readers = Array.from({ length: MAX_CONCURRENT_NODE_ENROLLMENTS_PER_PEER }, () => Promise.withResolvers<void>());
    const pending = readers.map((reader) => f.route(new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: cancellation.signal,
      body: new ReadableStream({ pull() { reader.resolve(); return new Promise(() => {}); } }),
    }), url, peer('192.0.2.1')));
    try {
      await Promise.all(readers.map((reader) => reader.promise));
      const rejected = await f.route(request(), url, peer('::ffff:192.0.2.1'));
      expect(rejected.status).toBe(429);
      expect(await rejected.json()).toMatchObject({ retryable: true });
      expect((await f.route(request(), url, peer('192.0.2.2'))).status).toBe(200);
    } finally { cancellation.abort(); await Promise.all(pending); }
    expect((await f.route(request(), url, peer('192.0.2.1'))).status).toBe(200);
  });

  test('rate limits the physical peer without trusting forwarded identities', async () => {
    const f = fixture();
    for (let index = 0; index < MAX_NODE_ENROLLMENTS_PER_PEER_PER_MINUTE; index++) {
      const input = request('{malformed');
      input.headers.set('X-Forwarded-For', `192.0.2.${index + 20}`);
      input.headers.set('X-Real-IP', `192.0.2.${index + 20}`);
      expect((await f.route(input, url, peer('192.0.2.1'))).status).toBe(400);
    }
    expect((await f.route(request(), url, peer('::ffff:c000:201'))).status).toBe(429);
    expect((await f.route(request(), url, peer('192.0.2.2'))).status).toBe(200);
    f.advance();
    expect((await f.route(request(), url, peer('192.0.2.1'))).status).toBe(200);
  });

  test('rejects plaintext before it can consume secure enrollment capacity', async () => {
    const f = fixture();
    const insecureUrl = new URL(`http://controller.test${path}`);
    for (let index = 0; index < MAX_NODE_ENROLLMENTS_PER_MINUTE; index++) {
      const input = new Request(insecureUrl, { method: 'POST', body: '{}' });
      expect((await f.route(input, insecureUrl, peer('192.0.2.1'))).status).toBe(403);
    }
    expect((await f.route(request(), url, peer('192.0.2.1'))).status).toBe(200);
  });

  test.each([false, true])('issuance distinguishes safe retry from renamed=%s uncertainty', async (renamed) => {
    const f = fixture();
    f.enrollment.issue.mockRejectedValue(new AtomicJsonWriteError('synthetic-private-storage', renamed));
    const issueUrl = new URL('https://controller.test/api/v1/execution-nodes/enrollment');
    const response = await f.routes[issueUrl.pathname]!.POST!(new Request(issueUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nodeId: 'node' }),
    }), issueUrl);
    expect(response.status).toBe(503);
    const payload = await response.json();
    expect(payload).toMatchObject({ errorCode: 'NODE_PAIRING_UNAVAILABLE', retryable: !renamed });
    expect(payload.error).not.toContain('synthetic-private-storage');
    expect(payload.error).not.toContain('revoke');
    expect(payload.error).toContain(renamed ? 'restart' : 'try again');
  });
});
