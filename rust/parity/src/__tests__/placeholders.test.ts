import { describe, expect, test } from 'bun:test';
import type { Capture, CapturedExchange } from '../capture.js';
import type { StartedServer } from '../environment.js';
import { normalizeCapture } from '../normalize.js';
import {
  dayOf, dayPlaceholders, dayPattern, expandJson, expandPlaceholders, placeholderNames, resolvePlaceholders,
} from '../placeholders.js';
import type { ScenarioStep } from '../scenario.js';
import type { Json } from '../wildcard.js';

const server = {
  origin: 'http://127.0.0.1:4100',
  baseUrl: 'http://127.0.0.1:4100',
  port: '4100',
  token: 'session-token',
  credentials: { username: 'parity', password: 'secret-password' },
  dirs: {
    root: '/tmp/garcon-parity-1',
    configDir: '/tmp/garcon-parity-1/config',
    workspaceDir: '/tmp/garcon-parity-1/workspace',
    projectDir: '/tmp/garcon-parity-1/project',
    homeDir: '/tmp/garcon-parity-1/home',
  },
  fallbackLogPath: '/tmp/garcon-parity-1/fallback.log',
  pid: 4100,
  startupMs: 1,
  logs: () => '',
  stop: async () => undefined,
} satisfies StartedServer;

const now = new Date('2026-11-27T23:30:00.000Z');
const executorId = '3f2a9c1e-7b4d-4e6f-8a90-123456789abc';
const storeId = '11111111-2222-3333-4444-555555555555';

function exchange(method: string, path: string, body: CapturedExchange['body']): Capture {
  return { request: { method, path, auth: 'token' }, status: 200, headers: {}, body };
}

const captures: ReadonlyMap<string, Capture> = new Map([
  ['create', exchange('POST', '/api/v1/executors', { kind: 'json', value: { id: executorId, endpoints: [{ id: 'ep-1' }] } })],
  ['boot', exchange('GET', '/api/v1/tickets/bootstrap', { kind: 'json', value: { storeId, collectionRevision: 7 } })],
  ['text', exchange('GET', '/api/v1/text', { kind: 'text', value: 'plain' })],
  ['short', exchange('POST', '/api/v1/short', { kind: 'json', value: { code: 'abc', enabled: true, missing: null } })],
]);

const resolve = (step: ScenarioStep) => resolvePlaceholders(server, step, captures, now);

describe('placeholders of a step', () => {
  test('name a value of an earlier response by step and JSON path, in a path, a query, a header, and a body', () => {
    const step: ScenarioStep = {
      name: 'patch',
      http: {
        method: 'PATCH',
        path: '/api/v1/executors/{{create.body.id}}?endpoint={{create.body.endpoints[0].id}}',
        headers: { 'X-Store': '{{boot.body.storeId}}' },
        json: {
          executorId: '{{create.body.id}}',
          expectedCollectionRevision: '{{boot.body.collectionRevision}}',
          note: 'revision {{boot.body.collectionRevision}}',
        },
      },
    };
    const resolved = resolve(step);
    expect(expandPlaceholders(step.http!.path!, resolved.values))
      .toBe(`/api/v1/executors/${executorId}?endpoint=ep-1`);
    expect(resolved.values['boot.body.storeId']).toBe(storeId);
    // A field whose whole value is the placeholder takes the value with its type.
    expect(expandJson(step.http!.json!, resolved)).toEqual({
      executorId,
      expectedCollectionRevision: 7,
      note: 'revision 7',
    });
    expect(resolved.carried).toEqual([[executorId, '{{create.body.id}}'], [storeId, '{{boot.body.storeId}}']]);
    expect(placeholderNames(step)).toEqual(['create.body.id', 'create.body.endpoints[0].id', 'boot.body.storeId', 'boot.body.collectionRevision']);
  });

  test('name a step whose name has hyphens, as scenarios name their steps', () => {
    const ticket = 'ticket-0123456789abcdef';
    const seeded: ReadonlyMap<string, Capture> = new Map([
      ['create-first', exchange('POST', '/api/v1/tickets', { kind: 'json', value: { ticket: { id: ticket, revision: 3 }, ok: true } })],
    ]);
    const step: ScenarioStep = {
      name: 'update-first',
      http: {
        method: 'PATCH',
        path: '/api/v1/tickets/{{create-first.body.ticket.id}}?revision={{create-first.body.ticket.revision}}',
        json: { expectedRevision: '{{create-first.body.ticket.revision}}', note: 'rev {{create-first.body.ticket.revision}}' },
      },
    };
    const resolved = resolvePlaceholders(server, step, seeded, now);
    expect(expandPlaceholders(step.http!.path!, resolved.values)).toBe(`/api/v1/tickets/${ticket}?revision=3`);
    expect(expandJson(step.http!.json!, resolved)).toEqual({ expectedRevision: 3, note: 'rev 3' });
    expect(resolved.carried).toEqual([[ticket, '{{create-first.body.ticket.id}}']]);
    // Text that only looks like a placeholder is still sent as written.
    expect(expandPlaceholders('{{not-a-placeholder}}', resolved.values)).toBe('{{not-a-placeholder}}');
  });

  test('keep the values of the server start and the text of a WebSocket step', () => {
    const step: ScenarioStep = {
      name: 'socket',
      ws: { path: '/ws', protocols: ['garcon', 'bearer.{{token}}'], send: [{ chatId: 'chat', projectPath: '{{projectDir}}' }] },
    };
    const resolved = resolve(step);
    expect(resolved.values).toEqual({ token: 'session-token', projectDir: '/tmp/garcon-parity-1/project' });
  });

  test('leave a placeholder they do not know as written', () => {
    const step: ScenarioStep = { name: 'literal', http: { method: 'POST', path: '/api/v1/templates', json: { text: '{{unknown}} {{not a placeholder}} {{a-b}}' } } };
    const resolved = resolve(step);
    expect(resolved.values).toEqual({});
    expect(expandJson(step.http!.json!, resolved)).toEqual(step.http!.json!);
  });

  test('carries only a string value long enough to be told from an unrelated word', () => {
    const resolved = resolve({
      name: 'use',
      http: { method: 'POST', path: '/api/v1/x', json: { code: '{{short.body.code}}', enabled: '{{short.body.enabled}}', missing: '{{short.body.missing}}' } },
    });
    expect(expandJson({ code: '{{short.body.code}}', enabled: '{{short.body.enabled}}', missing: '{{short.body.missing}}' }, resolved))
      .toEqual({ code: 'abc', enabled: true, missing: null });
    expect(resolved.values['short.body.enabled']).toBe('true');
    expect(resolved.carried).toEqual([]);
  });

  test('fail the step when the value cannot be had', () => {
    const failing = (placeholder: string, reason: string) => {
      const step: ScenarioStep = { name: 'later', http: { method: 'GET', path: `/api/v1/x/${placeholder}` } };
      expect(() => resolve(step)).toThrow(`later: ${placeholder} has no value: ${reason}.`);
    };
    failing('{{absent.body.id}}', 'no step named "absent" ran before it');
    failing('{{text.body.value}}', 'the response of "text" has no JSON body');
    failing('{{create.body.name}}', 'the response of "create" has no name');
    failing('{{create.body.id.x}}', 'the response of "create" has no id.x');
    failing('{{create.body.endpoints[2].id}}', 'the response of "create" has no endpoints[2].id');
    failing('{{boot.body.storeId[0]}}', 'the response of "boot" has no storeId[0]');
  });
});

describe('days relative to the clock', () => {
  test('are calendar days in UTC, in the form the usage route takes', () => {
    expect(dayOf('today', now)).toBe('2026-11-27');
    expect(dayOf('todayPlus7', now)).toBe('2026-12-04');
    expect(dayOf('todayMinus30', now)).toBe('2026-10-28');
    expect(dayOf('todayPlus0', now)).toBe('2026-11-27');
    expect(dayOf('today', new Date('2026-12-31T23:59:59.999Z'))).toBe('2026-12-31');
    expect(dayOf('todayPlus1', new Date('2026-12-31T00:00:30.000Z'))).toBe('2027-01-01');
    expect(dayOf('todayMinus1', new Date('2026-01-01T00:00:30.000Z'))).toBe('2025-12-31');
    expect(dayOf('todayPlus1', new Date('2024-02-28T12:00:00.000Z'))).toBe('2024-02-29');
    expect(dayOf('todayPlus2', new Date('2024-02-28T12:00:00.000Z'))).toBe('2024-03-01');
    expect(dayOf('todayPlus1', new Date('2026-11-27T12:00:00.000Z'))).toBe('2026-11-28');
    for (const other of ['todayPlus', 'todayMinus', 'todays', 'todayPlusX', 'Today', 'token']) {
      expect(dayOf(other, now)).toBeNull();
    }
  });

  test('are filled into a request from one clock for the step', () => {
    const step: ScenarioStep = {
      name: 'usage',
      http: { method: 'GET', path: '/api/v1/usage?sinceDay={{todayMinus6}}&untilDay={{today}}&timeZone={{todayPlus}}' },
    };
    const resolved = resolve(step);
    expect(expandPlaceholders(step.http!.path!, resolved.values))
      .toBe('/api/v1/usage?sinceDay=2026-11-21&untilDay=2026-11-27&timeZone={{todayPlus}}');
  });

  test('are the run\'s own day and the days the scenario names, and no other', () => {
    const step = (path: string): ScenarioStep => ({ name: path, http: { method: 'GET', path } });
    expect(dayPlaceholders([
      step('/api/v1/usage?sinceDay={{todayMinus6}}&untilDay={{today}}'),
      step('/api/v1/x?fixed=2026-01-01&other={{todayPlus90}}'),
      step('/api/v1/x?token={{token}}'),
    ], now)).toEqual([
      ['2026-11-27', '{{today}}'],
      ['2026-11-21', '{{todayMinus6}}'],
      ['2027-02-25', '{{todayPlus90}}'],
    ]);
    expect(dayPlaceholders([step('/api/v1/chats')], now)).toEqual([['2026-11-27', '{{today}}']]);
  });

  test('are normalized only as a whole day, not as the date of a timestamp or part of a longer number', () => {
    const text = 'today 2026-11-27, since 2026-11-21; fixed 2026-01-01; at 2026-11-27T10:00:00Z; '
      + 'short 2026-11-27T10:11Z; spaced 2026-11-27 10:11:12; range 2026-11-21/2026-11-27; '
      + 'joined 2026-11-20-2026-11-27; long 12026-11-27 and 2026-11-271; end 2026-11-27';
    const normalized = text
      .replace(dayPattern('2026-11-27'), '{{today}}')
      .replace(dayPattern('2026-11-21'), '{{todayMinus6}}');
    expect(normalized).toBe('today {{today}}, since {{todayMinus6}}; fixed 2026-01-01; at 2026-11-27T10:00:00Z; '
      + 'short 2026-11-27T10:11Z; spaced {{today}} 10:11:12; range {{todayMinus6}}/{{today}}; '
      + 'joined 2026-11-20-2026-11-27; long 12026-11-27 and 2026-11-271; end {{today}}');
  });
});

describe('normalizeCapture', () => {
  const text = (value: string): Capture => ({ request: { method: 'GET', path: '/x', auth: 'token' }, status: 200, headers: {}, body: { kind: 'text', value } });

  test('shows a value taken from an earlier response under its placeholder, in later responses', () => {
    const capture = exchange('GET', `/api/v1/executors/${executorId}`, { kind: 'json', value: { id: executorId, other: storeId, url: `http://127.0.0.1:4100/api/v1/executors/${executorId}` } });
    const carried: Array<readonly [string, string]> = [[executorId, '{{create.body.id}}']];
    expect(normalizeCapture(capture, server, { carried })).toEqual({
      request: { method: 'GET', path: '/api/v1/executors/{{create.body.id}}', auth: 'token' },
      status: 200,
      headers: {},
      body: { kind: 'json', value: { id: '{{create.body.id}}', other: '{{uuid}}', url: '{{origin}}/api/v1/executors/{{create.body.id}}' } },
    });
    // Without the reference the same value keeps the generic placeholder.
    expect((normalizeCapture(capture, server) as { body: { value: Json } }).body.value).toMatchObject({ id: '{{uuid}}' });
    expect(normalizeCapture(text(`ticket of ${executorId}`), server, { carried })).toMatchObject({ body: { value: 'ticket of {{create.body.id}}' } });
  });

  test('normalizes the run\'s own day and the named days in every string, and leaves other dates', () => {
    const capture = exchange('GET', '/x', {
      kind: 'json',
      value: { today: '2026-11-27', fixed: '2026-01-01', since: '2026-11-21', prompt: 'Today is 2026-11-27 (UTC).', at: '2026-11-27T10:00:00.000Z' },
    });
    expect(normalizeCapture(capture, server, { days: [['2026-11-27', '{{today}}'], ['2026-11-21', '{{todayMinus6}}']] })).toMatchObject({
      body: { value: { today: '{{today}}', fixed: '2026-01-01', since: '{{todayMinus6}}', prompt: 'Today is {{today}} (UTC).', at: '{{timestamp}}' } },
    });
    // A fixed date equal to none of them stays, and so does one that is not named.
    expect(normalizeCapture(exchange('GET', '/x', { kind: 'json', value: { a: '2026-11-28', b: '2026-11-21' } }), server, { days: [['2026-11-27', '{{today}}']] }))
      .toMatchObject({ body: { value: { a: '2026-11-28', b: '2026-11-21' } } });
  });

  test('ignores an empty value, such as the token of a server without an account', () => {
    const bare = { ...server, token: '', credentials: { username: 'parity', password: '' } };
    expect(normalizeCapture(text('/api/v1/auth/status session-token secret-password'), bare)).toMatchObject({ body: { value: '/api/v1/auth/status session-token secret-password' } });
  });
});
