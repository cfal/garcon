import { expect, test } from 'bun:test';
import { ProducerBindings } from '../producer-bindings.ts';
import { ProducerLease } from '../../ledger/producer-lease.ts';
import { LedgerFencedError } from '../../ledger/errors.ts';
import { createProducerFixture } from './producer-fixture.ts';

test('publication failure closes only its captured lease even if terminal persistence fails', async () => {
  const producer = createProducerFixture();
  const errors = [];
  const failures = [];
  const events = [];
  const manager = new ProducerBindings(error => errors.push(error), (chatId, lease, error) => {
    failures.push({ chatId, lease, error });
    throw new Error('Synthetic terminal failure');
  });
  const failed = new ProducerLease(event => events.push(event), () => {});
  const healthy = new ProducerLease(event => events.push(event), () => {});
  const integration = { producers: producer.producers };
  const binding = await manager.bind(integration, 'failed', failed);
  const other = await manager.bind(integration, 'healthy', healthy);
  const error = { code: 'OUTCOME_UNKNOWN', message: 'Synthetic publication failure' };
  producer.emit(binding, { type: 'publication-failed', error });
  expect(failures).toEqual([{ chatId: 'failed', lease: failed, error }]);
  expect(failed.closed).toBe(true);
  expect(errors).toHaveLength(1);
  producer.emit(binding, { type: 'rows', rows: [] });
  producer.emit(other, { type: 'rows', rows: [] });
  expect(events).toEqual([{ type: 'rows', rows: [] }]);
  healthy.close();
});

test('sink rejection is reported without escaping into other producer routes', async () => {
  const producer = createProducerFixture();
  const integration = { producers: producer.producers };
  const errors = [];
  const events = [];
  const failure = new LedgerFencedError('fenced-chat');
  const manager = new ProducerBindings(error => errors.push(error), () => {});
  const fenced = new ProducerLease(() => { throw failure; }, () => {});
  const healthy = new ProducerLease(event => events.push(event), () => {});
  const fencedBinding = await manager.bind(integration, 'fenced-chat', fenced);
  const healthyBinding = await manager.bind(integration, 'healthy-chat', healthy);
  try {
    expect(() => producer.emit(fencedBinding, { type: 'rows', rows: [] })).not.toThrow();
    producer.emit(healthyBinding, { type: 'rows', rows: [] });
    expect(errors).toEqual([failure]);
    expect(events).toEqual([{ type: 'rows', rows: [] }]);
  } finally {
    fenced.close();
    healthy.close();
  }
});

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
  const manager = new ProducerBindings(() => {}, () => {});
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
  const manager = new ProducerBindings(() => {}, () => {});
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
