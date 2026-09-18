import { expect, test } from 'bun:test';
import { ProducerBindings } from '../producer-bindings.ts';
import { ProducerLease } from '../../ledger/producer-lease.ts';
import { createProducerFixture } from './producer-fixture.ts';

test('every concurrent acquisition rejects closure during worker registration', async () => {
  const registered = Promise.withResolvers();
  const workerClose = Promise.withResolvers();
  const producer = createProducerFixture();
  const integration = { producers: {
    ...producer.producers,
    bind: () => registered.promise,
    close: () => workerClose.promise,
  } };
  const lease = new ProducerLease(() => { throw new Error('Closed route received an event'); }, () => {});
  const manager = new ProducerBindings(() => {});
  const first = manager.bind(integration, 'chat', lease);
  const second = manager.bind(integration, 'chat', lease);
  const outcomes = Promise.allSettled([first, second]);
  lease.close();
  registered.resolve();
  expect((await outcomes).map(result => result.status)).toEqual(['rejected', 'rejected']);
  await expect(manager.bind(integration, 'chat', lease)).rejects.toThrow('closed');
  workerClose.resolve();
});

test('late events cannot reach a replacement while remote close is pending', async () => {
  const workerClose = Promise.withResolvers();
  const producer = createProducerFixture();
  const integration = { producers: { ...producer.producers, close: () => workerClose.promise } };
  const events = [];
  const manager = new ProducerBindings(() => {});
  const lease = new ProducerLease(event => events.push(['old', event]), () => {});
  const oldBinding = await manager.bind(integration, 'chat', lease);
  lease.close();
  const replacement = new ProducerLease(event => events.push(['new', event]), () => {});
  const newBinding = await manager.bind(integration, 'chat', replacement);
  producer.emit(oldBinding, { type: 'rows', rows: [] });
  producer.emit(newBinding, { type: 'rows', rows: [] });
  expect(events).toEqual([['new', { type: 'rows', rows: [] }]]);
  await expect(manager.bind(integration, 'chat', lease)).rejects.toThrow('closed');
  replacement.close();
  workerClose.resolve();
});
