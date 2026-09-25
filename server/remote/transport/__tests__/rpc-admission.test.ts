import { expect, test } from 'bun:test';
import { validateCommandAttachments } from '../../../controller/attachments/validation.js';
import { remoteFixture, requestFor } from '../../__tests__/integration-fixture.js';

for (const dialer of ['controller', 'worker'] as const) {
  test(`oversized attachments reject before dispatch without retiring the executor (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = await requestFor(integration);
      const data = `data:image/png;base64,${Buffer.alloc(7 * 1024 * 1024).toString('base64')}`;
      const validated = validateCommandAttachments([{ name: 'first.png', data }, { name: 'second.png', data }])!;
      const attachments = validated.map(attachment => ({
        kind: 'image' as const, data: attachment.data, name: attachment.name ?? null, mimeType: attachment.mimeType!,
      }));
      const session = fixture.controller.current;
      await expect(integration.execution.start({ ...request, attachments })).rejects.toMatchObject({
        outcome: 'not-dispatched',
      });
      expect(fixture.generations[0]!.calls.start).toBe(0);
      expect(fixture.executor.availability).toBe('ready');
      expect(fixture.controller.current).toBe(session);
      await integration.execution.start(request);
      expect(fixture.generations[0]!.calls.start).toBe(1);
    } finally { await fixture.dispose(); }
  });

  test(`RPC frame admission counts JSON escaping (${dialer} dials)`, async () => {
    const fixture = await remoteFixture(dialer);
    try {
      const integration = await fixture.executor.getAgentIntegration('test');
      const request = { ...await requestFor(integration), prompt: '\u001f'.repeat(3 * 1024 * 1024) };
      expect(Buffer.byteLength(request.prompt)).toBeLessThan(16 * 1024 * 1024);
      expect(Buffer.byteLength(JSON.stringify(request))).toBeGreaterThan(16 * 1024 * 1024);
      await expect(integration.execution.start(request)).rejects.toMatchObject({ outcome: 'not-dispatched' });
      expect(fixture.generations[0]!.calls.start).toBe(0);
      expect(fixture.executor.availability).toBe('ready');
      await integration.execution.start({ ...request, prompt: 'small' });
      expect(fixture.generations[0]!.calls.start).toBe(1);
    } finally { await fixture.dispose(); }
  });
}
