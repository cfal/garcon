import { describe, expect, test } from 'bun:test';
import { decode, encode, encodeCall, encodeNumber } from '../unit/encode.js';

class DomainError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
    this.name = 'DomainError';
  }
}

class Thing {
  constructor(readonly name: string) {}
}

describe('encode', () => {
  test('keeps an own __proto__ key on plain objects and Errors without changing either prototype', () => {
    const input = JSON.parse('{"__proto__":{"recorded":true},"a":1}');
    const error = new Error('fixture');
    Object.defineProperty(error, '__proto__', { value: input.__proto__, enumerable: true });
    const object = encode(input);
    const encodedError = encode(error);
    if (!object.ok || !encodedError.ok) throw new Error('Expected both values to be encoded');
    expect(Object.hasOwn(object.value as object, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(object.value as object)).toBe(Object.prototype);
    const restored = decode(encodedError.value) as Error;
    expect(Object.hasOwn(restored, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(restored)).toBe(Error.prototype);
    expect(Object.getOwnPropertyDescriptor(restored, '__proto__')?.value).toEqual({ recorded: true });
  });

  test('keeps JSON values as they are', () => {
    expect(encode({ b: [1, 'x', true, null], a: { c: 0.5, d: 'ü 雪 😀' } })).toEqual({
      ok: true,
      value: { b: [1, 'x', true, null], a: { c: 0.5, d: 'ü 雪 😀' } },
    });
  });

  test('marks the values JSON cannot hold', () => {
    expect(encode([
      undefined, NaN, Infinity, -Infinity, -0, new Date('2026-11-27T10:11:12.000Z'),
      new Map([['a', 1]]), new Set([1, 2]), Uint8Array.from([1, 2, 3]), Buffer.from('hi'), 10n,
    ])).toEqual({
      ok: true,
      value: [
        { $: 'undefined' },
        { $: 'number', value: 'NaN' },
        { $: 'number', value: 'Infinity' },
        { $: 'number', value: '-Infinity' },
        { $: 'number', value: '-0' },
        { $: 'date', value: '2026-11-27T10:11:12.000Z' },
        { $: 'map', value: [['a', 1]] },
        { $: 'set', value: [1, 2] },
        { $: 'bytes', value: 'AQID' },
        { $: 'bytes', value: 'aGk=', buffer: true },
        { $: 'bigint', value: '10' },
      ],
    });
    expect(encodeNumber(0)).toBe(0);
    expect(encodeNumber(1e21)).toBe(1e21);
  });

  test('records an Error by name, message, and its other own enumerable properties', () => {
    const error = Object.assign(new DomainError('nope', 'E_X', 404), { retryable: false });
    expect(encode(error)).toEqual({
      ok: true,
      value: { $: 'error', name: 'DomainError', message: 'nope', properties: { code: 'E_X', status: 404, retryable: false } },
    });
    // `cause` is not enumerable, and Bun adds position properties to every Error.
    expect(encode(new TypeError('bad', { cause: error }))).toEqual({
      ok: true,
      value: {
        $: 'error',
        name: 'TypeError',
        message: 'bad',
        properties: {
          cause: { $: 'error', name: 'DomainError', message: 'nope', properties: { code: 'E_X', status: 404, retryable: false } },
        },
      },
    });
  });

  test('wraps a plain object that has the marker key', () => {
    expect(encode({ $: 'x', a: { $: 5 } })).toEqual({ ok: true, value: { $: 'object', value: { $: 'x', a: { $: 'object', value: { $: 5 } } } } });
    expect(encode(Object.create(null) as unknown)).toEqual({ ok: true, value: {} });
  });

  test('names the first value it cannot encode', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const cases: Array<[unknown, string, string]> = [
      [[1, (x: number) => x], '$.args[1]', 'a function'],
      [[Symbol('s')], '$.args[0]', 'a symbol'],
      [[new Thing('t')], '$.args[0]', 'a Thing instance'],
      [[new Float32Array(1)], '$.args[0]', 'a Float32Array instance'],
      [[circular], '$.args[0].self', 'a circular reference'],
      [[{ [Symbol('k')]: 1 }], '$.args[0]', 'an object with symbol-keyed properties'],
      [[{ a: [new WeakMap()] }], '$.args[0].a[0]', 'a WeakMap instance'],
      [[new Date('nope')], '$.args[0]', 'an invalid Date'],
    ];
    for (const [value, path, type] of cases) {
      expect(encode(value, '$.args')).toEqual({ ok: false, failure: { path, type } });
    }
  });
});

describe('decode', () => {
  test('restores every marked value', () => {
    const values: unknown[] = [
      undefined, NaN, Infinity, -Infinity, -0, new Date('2026-11-27T10:11:12.000Z'),
      new Map([['a', 1]]), new Set([1, 2]), Uint8Array.from([1, 2, 3]), Buffer.from('hi'), 10n,
      new TypeError('bad'), new DomainError('nope', 'E_X', 404),
      { $: 'x', a: [null, true] },
    ];
    for (const value of values) {
      const encoded = encode(value);
      if (!encoded.ok) throw new Error(encoded.failure.type);
      const decoded = decode(encoded.value) as Record<string, unknown>;
      expect(encode(decoded)).toEqual(encoded);
    }
    const error = decode({ $: 'error', name: 'DomainError', message: 'nope', properties: { code: 'E_X' } }) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DomainError');
    expect((error as DomainError).code).toBe('E_X');
    expect(decode({ $: 'error', name: 'TypeError', message: 'bad', properties: {} })).toBeInstanceOf(TypeError);
    const bytes = decode({ $: 'bytes', value: 'aGk=', buffer: true }) as Uint8Array;
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(Buffer.isBuffer(decode({ $: 'bytes', value: 'aGk=' }) as Uint8Array)).toBe(false);
  });
});

describe('encodeCall', () => {
  test('encodes the arguments and the returned value', () => {
    expect(encodeCall(['a', undefined], { kind: 'return', value: NaN })).toEqual({
      ok: true,
      args: ['a', { $: 'undefined' }],
      result: { $: 'number', value: 'NaN' },
    });
  });

  test('encodes a thrown Error as an error marker and any other thrown value as itself', () => {
    const error = Object.assign(new RangeError('too long'), { limit: 10 });
    expect(encodeCall([], { kind: 'throw', value: error })).toEqual({
      ok: true,
      args: [],
      result: { $: 'error', name: 'RangeError', message: 'too long', properties: { limit: 10 } },
    });
    expect(encodeCall([], { kind: 'throw', value: 'plain' })).toEqual({ ok: true, args: [], result: { $: 'throw', value: 'plain' } });
    // Returned, the same Error is a value like any other.
    expect(encodeCall([], { kind: 'return', value: error })).toEqual(encodeCall([], { kind: 'throw', value: error }));
  });

  test('says whether the arguments or the outcome could not be encoded', () => {
    expect(encodeCall([new Thing('t')], { kind: 'return', value: 1 })).toEqual({
      ok: false,
      where: 'args',
      failure: { path: '$.args[0]', type: 'a Thing instance' },
    });
    expect(encodeCall([1], { kind: 'return', value: { done: () => undefined } })).toEqual({
      ok: false,
      where: 'result',
      failure: { path: '$.result.done', type: 'a function' },
    });
  });
});
