import { expect, spyOn, test } from 'bun:test';
import { remoteFixture, requestFor } from '../../__tests__/integration-fixture.js';

function redactionWarnings(warn: { readonly mock: { readonly calls: unknown[][] } }): unknown[][] {
  return warn.mock.calls.filter(([scope]) => scope === '[executor-rpc]');
}

function redactedCall(method: string) {
  return [
    '[executor-rpc]', 'Executor call failed on malformed data', {
      callId: expect.any(String), integrationId: 'test', method, reason: expect.stringMatching(/^Malformed data/),
    },
  ];
}

for (const dialer of ['controller', 'worker'] as const) {
  test(`a handler's parse error crosses the link as malformed data and is logged with its call where it was thrown (${dialer} dials)`, async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = await remoteFixture(dialer);
    try {
      fixture.generations[0]!.hooks.query = async () => {
        const reply: unknown = JSON.parse('{"reply": SYNTHETIC_SENTINEL}');
        return String(reply);
      };
      const integration = await fixture.executor.getAgentIntegration('test');
      await expect(integration.singleQuery!.run({
        prompt: 'Synthetic query', model: 'test-model', thinkingMode: 'medium',
        settings: integration.settings.defaults(), endpoint: null, signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'PROVIDER_FAILURE', message: 'Malformed data' });

      expect(redactionWarnings(warn)).toEqual([redactedCall('singleQuery.run')]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SYNTHETIC_SENTINEL');
    } finally {
      warn.mockRestore();
      await fixture.dispose();
    }
  });

  // Launches are not journaled, so their replies take the session's own reply path.
  test(`a launch's parse error is logged with its call where it was thrown (${dialer} dials)`, async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const fixture = await remoteFixture(dialer);
    try {
      fixture.generations[0]!.hooks.start = async () => { JSON.parse('{"run": SYNTHETIC_SENTINEL}'); };
      const integration = await fixture.executor.getAgentIntegration('test');
      await expect(integration.execution.start(await requestFor(integration))).rejects.toMatchObject({ message: 'Malformed data' });

      expect(redactionWarnings(warn)).toEqual([redactedCall('execution.start')]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SYNTHETIC_SENTINEL');
    } finally {
      warn.mockRestore();
      await fixture.dispose();
    }
  });
}
