import type { ExecutorsChangedMessage } from '../../common/ws-events.js';
import type { IntegrationFixture } from './integration-fixture.js';

export async function waitForExecutorReconnect(fixture: IntegrationFixture, afterIndex: number): Promise<void> {
  const { client } = fixture;
  const offline = await client.waitForEvent(
    (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
      && event.executors.some(executor => executor.id === client.executorId && executor.availability === 'offline'),
    'executor offline after link loss', { afterIndex, timeoutMs: 20_000 },
  );
  const offlineIndex = client.events().indexOf(offline);
  await client.waitForEvent(
    (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
      && event.executors.some(executor => executor.id === client.executorId && executor.availability === 'ready'),
    'executor reconnected after link loss', { afterIndex: offlineIndex + 1, timeoutMs: 20_000 },
  );
}
