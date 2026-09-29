import type { ExecutorsChangedMessage } from '../../common/ws-events.js';
import type { IntegrationFixture } from './integration-fixture.js';

export async function waitForExecutorReconnect(fixture: IntegrationFixture, afterIndex: number): Promise<void> {
  const { client } = fixture;
  const unavailable = await client.waitForEvent(
    (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
      && event.executors.some(executor => executor.id === client.executorId && executor.availability !== 'ready'),
    'executor unavailable after link loss', { afterIndex, timeoutMs: 20_000 },
  );
  const unavailableIndex = client.events().indexOf(unavailable);
  await client.waitForEvent(
    (event): event is ExecutorsChangedMessage => event.type === 'executors-changed'
      && event.executors.some(executor => executor.id === client.executorId && executor.availability === 'ready'),
    'executor reconnected after link loss', { afterIndex: unavailableIndex + 1, timeoutMs: 20_000 },
  );
}
