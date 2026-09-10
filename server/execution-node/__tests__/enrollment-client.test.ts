import { describe, expect, mock, spyOn, test } from 'bun:test';
import { MAX_NODE_ENROLLMENT_EXCHANGE_BYTES, NODE_ENROLLMENT_TIMEOUT_MS, type NodeEnrollmentBundle, type NodeEnrollmentResponse } from '../../../common/execution-node-config.js';
import { enrollExecutionNode } from '../enrollment-client.js';

const bundle = (): NodeEnrollmentBundle => ({
  version: 1, nodeId: 'node', controllerId: 'controller', controllerUrl: 'https://controller.test',
  trust: { kind: 'system-ca' }, expiresAt: new Date(Date.now() + 60_000).toISOString(), token: `enroll.token.${'A'.repeat(43)}`,
});
const paired = (): NodeEnrollmentResponse => ({ version: 1, nodeId: 'node', controllerId: 'controller', credential: `node.node.${'A'.repeat(43)}` });
const signal = () => new AbortController().signal;

describe('single-use node enrollment client', () => {
  test('snapshots the bundle and sends exactly one scoped verified HTTPS exchange', async () => {
    const input = { ...bundle() };
    const original = structuredClone(input);
    const fetcher = mock(async (_url: string, _init: Parameters<typeof fetch>[1]) => Response.json(paired()));
    const pending = enrollExecutionNode(input, signal(), { fetch: fetcher });
    input.controllerUrl = 'http://changed.test';
    input.controllerId = 'changed';
    input.token = 'changed';
    expect(await pending).toEqual({ ...paired(), controllerUrl: original.controllerUrl, trust: original.trust });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://controller.test/api/v1/execution-nodes/enroll');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', tls: { rejectUnauthorized: true } });
    expect(init!.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init!.body))).toEqual({ version: 1, controllerId: original.controllerId, nodeId: original.nodeId, token: original.token });
    expect(init!.signal!.aborted).toBe(false);
  });

  test('rejects malformed, expired, or pre-cancelled input before network access', async () => {
    const fetcher = mock(async () => Response.json(paired()));
    for (const input of [
      { ...bundle(), controllerUrl: 'http://controller.test' },
      { ...bundle(), expiresAt: '2020-01-01T00:00:00.000Z' },
      { ...bundle(), trust: { kind: 'trusted-pem' as const, certificatesPem: ['-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n'], certificateSha256: ['a'.repeat(64)] } },
    ]) await expect(enrollExecutionNode(input, signal(), { fetch: fetcher })).rejects.toThrow();
    const controller = new AbortController();
    controller.abort(new Error('Synthetic pre-entry cancellation'));
    await expect(enrollExecutionNode(bundle(), controller.signal, { fetch: fetcher })).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_CANCELLED' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('rejects wrong response identity, invalid bodies, and errors without retaining or retrying credentials', async () => {
    for (const response of [
      Response.json({ ...paired(), controllerId: 'another-controller' }),
      Response.json({ ...paired(), nodeId: 'another-node' }),
      Response.json({ ...paired(), credential: `node.another-node.${'A'.repeat(43)}` }),
      Response.json({ ...paired(), version: 2 }),
      Response.json({ ...paired(), privateData: 'unexpected' }),
      new Response('x'.repeat(MAX_NODE_ENROLLMENT_EXCHANGE_BYTES + 1), { headers: { 'Content-Type': 'application/json' } }),
      new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json' } }),
      Response.json({ errorCode: 'unknown', error: 'synthetic-private-message' }, { status: 503 }),
    ]) {
      const fetcher = mock(async () => response);
      const error = await enrollExecutionNode(bundle(), signal(), { fetch: fetcher }).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE' });
      expect(String(error)).not.toContain('synthetic-private-message');
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(response.body!.locked).toBe(false);
    }
    const fetcher = mock(async () => Response.json({ errorCode: 'NODE_ENROLLMENT_EXPIRED' }, { status: 401 }));
    await expect(enrollExecutionNode(bundle(), signal(), { fetch: fetcher })).rejects.toMatchObject({ code: 'NODE_ENROLLMENT_EXPIRED' });
  });

  test('cancellation rejects an abort-ignoring fetch and cancels its late response', async () => {
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Response>();
    const fetcher = mock(async () => { entered.resolve(); return reply.promise; });
    const controller = new AbortController();
    const pending = enrollExecutionNode(bundle(), controller.signal, { fetch: fetcher });
    await entered.promise;
    controller.abort(new Error('Synthetic cancellation'));
    await expect(pending).rejects.toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE' });
    const cancelled = Promise.withResolvers<void>();
    reply.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } })));
    await cancelled.promise;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('preserves safe retry guidance only for explicit rejection without automatically retrying', async () => {
    for (const [code, status, retryable, guidance] of [
      ['NODE_PAIRING_CAPACITY', 429, true, 'try this bundle again'],
      ['NODE_TLS_REQUIRED', 403, false, 'configuration'],
      ['NODE_ADMIN_REQUIRED', 403, false, 'configuration'],
      ['NODE_ENROLLMENT_EXPIRED', 401, false, 'new bundle'],
      ['NODE_PAIRING_UNAVAILABLE', 503, false, 'revoke and reissue'],
    ] as const) {
      const fetcher = mock(async () => Response.json({ errorCode: code, retryable, error: 'synthetic-private-message' }, { status }));
      const error = await enrollExecutionNode(bundle(), signal(), { fetch: fetcher }).catch((error: unknown) => error);
      expect(error).toMatchObject({ code, retryable });
      expect(String(error)).toContain(guidance);
      expect(String(error)).not.toContain('synthetic-private-message');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    const fetcher = mock(async () => Response.json({ errorCode: 'unexpected', retryable: true }, { status: 503 }));
    await expect(enrollExecutionNode(bundle(), signal(), { fetch: fetcher })).rejects.toMatchObject({ retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('cancellation rejects a stalled response and releases its reader', async () => {
    const reading = Promise.withResolvers<void>();
    const response = new Response(new ReadableStream({ pull() { reading.resolve(); return new Promise(() => {}); } }), {
      headers: { 'Content-Type': 'application/json' },
    });
    const controller = new AbortController();
    const fetcher = mock(async () => response);
    const pending = enrollExecutionNode(bundle(), controller.signal, { fetch: fetcher });
    await reading.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE' });
    expect(response.body!.locked).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('uses a bounded deadline and clears it on timeout and success', async () => {
    const timer = spyOn(globalThis, 'setTimeout');
    const clear = spyOn(globalThis, 'clearTimeout');
    try {
      const entered = Promise.withResolvers<void>();
      const fetcher = mock(async () => { entered.resolve(); return new Promise<Response>(() => {}); });
      const pending = enrollExecutionNode(bundle(), signal(), { fetch: fetcher });
      await entered.promise;
      const scheduled = timer.mock.calls.find((call) => call[1] === NODE_ENROLLMENT_TIMEOUT_MS)!;
      (scheduled[0] as () => void)();
      await expect(pending).rejects.toMatchObject({ code: 'NODE_PAIRING_UNAVAILABLE' });
      expect(clear).toHaveBeenCalledTimes(1);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await enrollExecutionNode(bundle(), signal(), { fetch: async () => Response.json(paired()) });
      expect(clear).toHaveBeenCalledTimes(2);
    } finally { timer.mockRestore(); clear.mockRestore(); }
  });

  test('reports typed TLS failures without including arbitrary provider diagnostics', async () => {
    for (const [code, reason] of [
      ['CERT_HAS_EXPIRED', 'certificate-expired'], ['ERR_TLS_CERT_ALTNAME_INVALID', 'hostname-mismatch'],
      ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate-untrusted'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate-untrusted'],
    ]) {
      const fetcher = mock(async () => { throw Object.assign(new Error('synthetic-private-detail'), { code }); });
      const error = await enrollExecutionNode(bundle(), signal(), { fetch: fetcher }).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: 'NODE_TLS_UNTRUSTED', tlsReason: reason });
      expect(String(error)).not.toContain('synthetic-private-detail');
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
});
