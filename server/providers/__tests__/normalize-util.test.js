import { describe, it, expect } from 'bun:test';
import { normalizeToolInput, normalizeToolResultContent } from '../normalize-util.js';

describe('normalizeToolInput', () => {
  it('returns empty object for null', () => {
    expect(normalizeToolInput(null)).toEqual({});
  });

  it('returns empty object for undefined', () => {
    expect(normalizeToolInput(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(normalizeToolInput('')).toEqual({});
  });

  it('passes through plain objects unchanged', () => {
    const input = { command: 'ls -la', cwd: '/tmp' };
    expect(normalizeToolInput(input)).toEqual(input);
  });

  it('passes through nested objects', () => {
    const input = { outer: { inner: [1, 2, 3] }, flag: true };
    expect(normalizeToolInput(input)).toEqual(input);
  });

  it('parses a JSON string into an object', () => {
    const input = '{"command":"ls","flag":true}';
    expect(normalizeToolInput(input)).toEqual({ command: 'ls', flag: true });
  });

  it('wraps non-JSON strings in a raw field', () => {
    expect(normalizeToolInput('not-json')).toEqual({ raw: 'not-json' });
  });

  it('wraps JSON strings that parse to non-objects', () => {
    expect(normalizeToolInput('"just a string"')).toEqual({ raw: '"just a string"' });
    expect(normalizeToolInput('42')).toEqual({ raw: '42' });
    expect(normalizeToolInput('true')).toEqual({ raw: 'true' });
  });

  it('wraps JSON arrays in a raw field', () => {
    expect(normalizeToolInput('[1,2,3]')).toEqual({ raw: '[1,2,3]' });
  });

  it('returns empty object for arrays', () => {
    expect(normalizeToolInput([1, 2, 3])).toEqual({});
  });

  it('returns empty object for non-string, non-object types', () => {
    expect(normalizeToolInput(42)).toEqual({});
    expect(normalizeToolInput(true)).toEqual({});
  });
});

describe('normalizeToolResultContent', () => {
  it('returns empty object for null/undefined', () => {
    expect(normalizeToolResultContent(null)).toEqual({});
    expect(normalizeToolResultContent(undefined)).toEqual({});
  });

  it('passes through plain objects unchanged', () => {
    const obj = { toolUseResult: { numFiles: 3 } };
    expect(normalizeToolResultContent(obj)).toEqual(obj);
  });

  it('wraps arrays in items key', () => {
    const arr = [{ type: 'text', text: 'hello' }];
    expect(normalizeToolResultContent(arr)).toEqual({ items: arr });
  });

  it('returns empty object for empty/whitespace strings', () => {
    expect(normalizeToolResultContent('')).toEqual({});
    expect(normalizeToolResultContent('  ')).toEqual({});
  });

  it('wraps non-JSON strings in raw field', () => {
    expect(normalizeToolResultContent('File changes applied')).toEqual({ raw: 'File changes applied' });
  });

  it('parses JSON object strings', () => {
    expect(normalizeToolResultContent('{"key":"value"}')).toEqual({ key: 'value' });
  });

  it('parses JSON array strings into items', () => {
    expect(normalizeToolResultContent('[1,2,3]')).toEqual({ items: [1, 2, 3] });
  });

  it('wraps non-object JSON values in raw', () => {
    expect(normalizeToolResultContent('"just a string"')).toEqual({ raw: '"just a string"' });
  });
});
