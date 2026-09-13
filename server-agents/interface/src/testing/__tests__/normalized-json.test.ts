import { expect, test } from 'bun:test';
import { isNormalizedJsonObject, isSnapshotJsonObject } from '../../normalized-json.js';
import { NodeWireSnapshot } from '../../node-wire-snapshot.js';

test('raw validation retains its strict array shape while snapshots own only indexed values', () => {
  const extraField = Object.assign([1, 2], { extra: 'synthetic' });
  const nonEnumerableIndex = Object.defineProperty([1, 2], '0', { enumerable: false });
  for (const values of [extraField, nonEnumerableIndex]) {
    expect(isNormalizedJsonObject({ values })).toBe(false);
    const captured = new NodeWireSnapshot().value({ values });
    expect(captured).toEqual({ values: [1, 2] });
    expect(isSnapshotJsonObject(captured)).toBe(true);
    expect(isNormalizedJsonObject(captured)).toBe(true);
  }
});

test('snapshot validation still rejects holes and undefined values at every nesting level', () => {
  for (const value of [
    { values: Array(2) }, { values: [1, undefined] }, { values: [{ missing: undefined }] },
    { nested: { missing: undefined } },
  ]) {
    expect(isNormalizedJsonObject(value)).toBe(false);
    expect(isSnapshotJsonObject(new NodeWireSnapshot().value(value))).toBe(false);
  }
});

test('snapshot validation cannot reread a provider array getter', () => {
  let reads = 0;
  const values = Object.defineProperty([], '0', {
    enumerable: true, get() { return ++reads === 1 ? { value: 1 } : { value: undefined }; },
  });
  const captured = new NodeWireSnapshot().value({ values });
  expect(isSnapshotJsonObject(captured)).toBe(true);
  expect(isSnapshotJsonObject(captured)).toBe(true);
  expect(captured).toEqual({ values: [{ value: 1 }] });
  expect(reads).toBe(1);
});

test('raw normalized validation still rejects non-JSON values and custom serialization', () => {
  for (const value of [
    { values: [NaN] }, { values: [Infinity] }, { values: [() => 1] },
    { values: [1n] }, { values: [Symbol('synthetic')] }, { values: new Date(0) },
    { values: Object.assign([1], { toJSON: () => [2] }) },
  ]) expect(isNormalizedJsonObject(value)).toBe(false);
});

test.each(['value', 'array'] as const)('%s capture owns indexed values despite an inherited setter', (method) => {
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let intercepted = 0;
  let captured: unknown;
  const values = new Proxy([7], {
    get(target, property, receiver) {
      if (property === '0') {
        Object.defineProperty(Array.prototype, '0', {
          configurable: true,
          get() { return 99; },
          set() { intercepted++; },
        });
      }
      return Reflect.get(target, property, receiver);
    },
  });
  try {
    const snapshot = new NodeWireSnapshot();
    captured = method === 'value' ? snapshot.value(values) : snapshot.array(values, (item) => item);
  } finally {
    if (previous) Object.defineProperty(Array.prototype, '0', previous);
    else Reflect.deleteProperty(Array.prototype, '0');
  }
  expect(intercepted).toBe(0);
  expect(Object.getOwnPropertyDescriptor(captured, '0')).toEqual({
    value: 7, enumerable: true, writable: true, configurable: true,
  });
  expect(isSnapshotJsonObject({ values: captured })).toBe(true);
  expect(JSON.stringify(captured)).toBe('[7]');
});

test.each([2.5, '2.5', -1, NaN])('noncanonical proxy length %s retains sequential capture', (length) => {
  const values = new Proxy([1, 2, 3], {
    get(target, property, receiver) {
      return property === 'length' ? length : Reflect.get(target, property, receiver);
    },
  });
  const expected = Number(length) > 0 ? [1, 2, 3] : [];
  expect(new NodeWireSnapshot().value(values)).toEqual(expected);
  expect(new NodeWireSnapshot().array(values, (item) => item)).toEqual(expected);
});
