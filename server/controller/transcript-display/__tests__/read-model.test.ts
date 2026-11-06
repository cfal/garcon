import { afterEach, describe, expect, test } from 'bun:test';
import { AssistantMessage, AskUserQuestionToolUseMessage, BashToolUseMessage, GlobToolUseMessage, PermissionRequestMessage, ToolResultMessage, UserMessage } from '../../../../common/chat-types.js';
import type { ChatMessage } from '../../../../common/chat-types.js';
import type { DisplayProfile, DisplayWindowRequest, MemberWindowRequest } from '../../../../common/transcript-display-contract.js';
import { parseDisplayWindowResponse, parseMemberWindowResponse } from '../../../../common/transcript-display-contract.js';
import { DISPLAY_POLICY_REVISION } from '../../../../common/transcript-display-policy.js';
import { encodeLedgerDraft, type StoredLedgerRow } from '../../ledger/codec.js';
import { DisplayStore } from '../store.js';
import { appendDisplayFrame } from '../extractor.js';
import { DisplayQuery, displayCertificate } from '../query.js';
import { prepareBashFrame, pruneBashRevision } from '../bash-revision.js';
import { planBodyRead } from '../details.js';
import { queryResend, queryUserRows } from '../auxiliary-query.js';
import { displayErrorCode } from '../errors.js';

const at = '2026-01-01T00:00:00.000Z';
const profile: DisplayProfile = { combine: true, showThinking: true, hiddenToolGroups: [], bashRevision: 'patterns' };
const stores: DisplayStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function create() {
  const store = new DisplayStore(':memory:'); store.initialize('chat', 'view', 'server'); stores.push(store); return store;
}
function stored(messages: ChatMessage[], start = 1): StoredLedgerRow[] {
  return messages.map((message, i) => {
    const draft = { kind: 'provider-row' as const, at, message };
    const encoded = encodeLedgerDraft(draft);
    return { view_id: 'view', ordinal: start + i, kind: draft.kind, at, client_message_id: null, payload_json: encoded.payloadJson };
  });
}
function query(store: DisplayStore, limit = 50, anchor: DisplayWindowRequest['anchor'] = { kind: 'newest' }, cuts: DisplayWindowRequest['cuts'] = []) {
  const W = store.manifest()!.prepared_through;
  const request: DisplayWindowRequest = { chatId: 'chat', transcriptViewId: 'view', policyRevision: DISPLAY_POLICY_REVISION, profile, cuts, limit, anchor };
  const engine = new DisplayQuery(store, profile, W, cuts, false);
  return engine.window(request, displayCertificate('server', request, W), W, W);
}

describe('persistent transcript display read model', () => {
  test('an after cursor beyond the watermark returns a valid exhausted interval', () => {
    const store = create();
    appendDisplayFrame(store, stored([new UserMessage(at, 'Generic prompt'), new AssistantMessage(at, 'Generic answer')]), 2, 'server');
    const initial = query(store);
    const next = parseDisplayWindowResponse(query(store, 50, {
      kind: 'after', cursor: { certificate: initial.certificate, boundaryOrdinal: 3 },
    }));
    expect(next).toMatchObject({ kind: 'available', interval: { after: 2, through: 2 }, items: [], later: { kind: 'exhausted-through-watermark' } });
  });
  test.each([
    ['SQLITE_CORRUPT_INDEX', 'DISPLAY_STORE_INVALID'], ['SQLITE_NOTADB', 'DISPLAY_STORE_INVALID'],
    ['SQLITE_BUSY_RECOVERY', 'DISPLAY_BUSY'], ['SQLITE_BUSY_SNAPSHOT', 'DISPLAY_BUSY'],
    ['SQLITE_LOCKED_SHAREDCACHE', 'DISPLAY_BUSY'], ['SQLITE_FULL', 'DISPLAY_DISK_FULL'],
  ])('maps extended SQLite failure %s to %s', (code, expected) => {
    expect(displayErrorCode(Object.assign(new Error('Synthetic failure'), { code }))).toBe(expected);
  });

  test('freshly rebuilt stores cannot certify bodies or auxiliary pages beyond their frontier', () => {
    const store = create();
    const identity = { serverInstanceId: 'server', chatId: 'chat', transcriptViewId: 'view', watermark: 2, sourceHead: 2 };
    const request = { chatId: 'chat', transcriptViewId: 'view', limit: 50 };
    const reads = [
      () => new DisplayQuery(store, profile, 2, [], false),
      () => planBodyRead(store, { certificate: displayCertificate('server', { ...request, profile, cuts: [] }, 2),
        profile, cuts: [], seedOrdinals: [1], residentOrdinals: [], limitBodies: 50, estimatedByteBudget: 10000 }),
      () => queryUserRows(store, request, identity),
      () => queryResend(store, request, identity),
    ];
    for (const read of reads) {
      try { read(); throw new Error('An unprepared prefix was accepted'); }
      catch (error) { expect(error).toMatchObject({ code: 'DISPLAY_PREPARING' }); }
    }
  });

  test.each([true, false])('resolves question results to their visible wrapper, wrapper-first=%s', (wrapperFirst) => {
    const store = create();
    const question = new AskUserQuestionToolUseMessage(at, 'question', 'Generic title', []);
    const wrapper = new PermissionRequestMessage(at, 'occurrence', question);
    const messages = [...(wrapperFirst ? [wrapper, question] : [question, wrapper]), new ToolResultMessage(at, 'question', 'Generic answer')];
    appendDisplayFrame(store, stored(messages), 3, 'server');
    expect(new DisplayQuery(store, profile, 3, [], false).resolve(3, 3)).toEqual({
      kind: 'attached-detail', ordinal: 3, landedOrdinal: wrapperFirst ? 1 : 2,
    });
    expect(new DisplayQuery(store, profile, 2, [], false).resolve(3, 3).kind).toBe('preparing');
    store.run('UPDATE tool_pair SET wrapper_ordinal = 4');
    expect(new DisplayQuery(store, profile, 3, [], false).resolve(3, 3).kind).toBe('non-rendered');
  });

  test('a partially pruned Bash revision is never certified and rebuilds after pruning', () => {
    const store = create();
    const rows = stored(Array.from({ length: 2600 }, (_, i) => new BashToolUseMessage(at, `tool-${i}`, 'true')));
    appendDisplayFrame(store, rows, rows.length, 'server');
    const patterns = [{ mode: 'regex' as const, pattern: 'not-present' }];
    while (prepareBashFrame(store, 'patterns', patterns, rows.length) < rows.length) {}
    expect(new DisplayQuery(store, profile, rows.length, [], true).group(1).count).toBe(2600);
    expect(pruneBashRevision(store, 'patterns')).toBe(false);
    expect(() => new DisplayQuery(store, profile, rows.length, [], true)).toThrow('not prepared');
    expect(() => prepareBashFrame(store, 'patterns', patterns, rows.length)).toThrow('retired');
    while (!pruneBashRevision(store, 'patterns')) {}
    while (prepareBashFrame(store, 'patterns', patterns, rows.length) < rows.length) {}
    expect(new DisplayQuery(store, profile, rows.length, [], true).group(1).count).toBe(2600);
  });

  test('empty directional pages only certify their requested interval', () => {
    const store = create();
    appendDisplayFrame(store, stored([new UserMessage(at, 'Generic prompt'), new AssistantMessage(at, 'Generic answer')]), 2, 'server');
    const full = query(store);
    const before = query(store, 50, { kind: 'before', cursor: { certificate: full.certificate, boundaryOrdinal: 1 } });
    expect(before.interval).toEqual({ after: 0, through: 0 });
    expect(before.later.kind).toBe('more');
    const after = query(store, 50, { kind: 'after', cursor: { certificate: full.certificate, boundaryOrdinal: 2 } });
    expect(after.interval).toEqual({ after: 2, through: 2 });
    expect(after.earlier.kind).toBe('more');
  });
  test('[TLV5-DISPLAY.01-CORE-UNIT-01] prepared traversal and middle-target extents do not enumerate a collapsed run', () => {
    const counts: number[] = [];
    for (const members of [600, 1500, 40000]) {
      const store = create();
      const messages: ChatMessage[] = [new UserMessage(at, 'Generic prompt')];
      for (let i = 0; i < members; i++) messages.push(new BashToolUseMessage(at, `tool-${i}`, 'true'), new ToolResultMessage(at, `tool-${i}`, 'ok'));
      messages.push(new AssistantMessage(at, 'Generic answer'));
      const rows = stored(messages);
      for (let from = 0; from < rows.length; from += 256) appendDisplayFrame(store, rows.slice(from, from + 256), rows.length, 'server');
      store.statements = 0;
      const window = query(store, 3, { kind: 'around', ordinal: members });
      counts.push(store.statements);
      expect(window.items).toHaveLength(3);
      expect(window.items[1]).toMatchObject({ kind: 'tool-group', count: members, firstMember: 2, lastMember: members * 2,
        base: { afterBreaker: 1, beforeBreaker: members * 2 + 2 } });
      expect(JSON.stringify(window).length).toBeLessThan(2500);
    }
    expect(new Set(counts).size).toBe(1);
  });

  test('[TLV5-DISPLAY.02-CORE-UNIT-01] uses exact FIFO across frames and never attaches future evidence to old details', () => {
    const store = create();
    const rows = stored([new GlobToolUseMessage(at, 'same', '*'), new BashToolUseMessage(at, 'same', 'true'),
      new UserMessage(at, 'Between occurrences'), new ToolResultMessage(at, 'same', 'files'), new ToolResultMessage(at, 'same', 'ok')]);
    for (const row of rows) appendDisplayFrame(store, [row], rows.length, 'server');
    expect(store.all('SELECT use_ordinal, result_ordinal FROM tool_pair ORDER BY use_ordinal')).toEqual([
      { use_ordinal: 1, result_ordinal: 4 }, { use_ordinal: 2, result_ordinal: 5 },
    ]);
    const request = { certificate: displayCertificate('server', { chatId: 'chat', transcriptViewId: 'view', profile, cuts: [] }, 2),
      profile, cuts: [], seedOrdinals: [1], residentOrdinals: [], limitBodies: 20, estimatedByteBudget: 10000 };
    expect(planBodyRead(store, request).details[0].pairedResult).toBeNull();
    expect(planBodyRead(store, { ...request, certificate: { ...request.certificate, watermark: 5 } }).details[0].pairedResult).toBe(4);
  });

  test('splits aggregate runs at overlay positions and pages complete fragments', () => {
    const store = create();
    const rows = stored(Array.from({ length: 12 }, (_, i) => new BashToolUseMessage(at, `tool-${i}`, 'true')));
    appendDisplayFrame(store, rows, rows.length, 'server');
    const cuts = [{ id: 'optimistic', afterOrdinal: 5, anchorRule: 'raw-position' as const }];
    const latest = query(store, 1, { kind: 'newest' }, cuts);
    expect(latest.items[0]).toMatchObject({ count: 7, firstMember: 6, lastMember: 12 });
    expect(latest.earlier.kind).toBe('more');
    if (latest.earlier.kind !== 'more') throw new Error('Expected continuation');
    const older = query(store, 1, { kind: 'before', cursor: latest.earlier.cursor }, cuts);
    expect(older.items[0]).toMatchObject({ count: 5, firstMember: 1, lastMember: 5 });
    expect(older.earlier.kind).toBe('exhausted-through-watermark');
  });

  test('prepares positive Bash result eligibility including empty-command failures', () => {
    const store = create();
    const rows = stored([new BashToolUseMessage(at, 'empty', ''), new ToolResultMessage(at, 'empty', 'error', true),
      new BashToolUseMessage(at, 'ordinary', 'true')]);
    appendDisplayFrame(store, rows, rows.length, 'server');
    const patterns = [{ mode: 'regex' as const, pattern: '^$' }];
    while (prepareBashFrame(store, 'patterns', patterns, rows.length) < rows.length) {}
    const engine = new DisplayQuery(store, profile, rows.length, [], true);
    expect(engine.eligible(1)).toBe(false); expect(engine.eligible(2)).toBe(false); expect(engine.eligible(3)).toBe(true);
    expect(engine.group(3)).toMatchObject({ count: 1, firstMember: 3, lastMember: 3 });
  });

  test('deep member pages are bounded and carry exact remaining counts', () => {
    const store = create();
    const rows = stored(Array.from({ length: 1000 }, (_, i) => new BashToolUseMessage(at, `tool-${i}`, 'true')));
    appendDisplayFrame(store, rows, rows.length, 'server');
    const window = query(store), group = window.items[0];
    if (group.kind !== 'tool-group') throw new Error('Expected group');
    const response = new DisplayQuery(store, profile, 1000, [], false).memberWindow({ certificate: window.certificate,
      profile, cuts: [], base: group.base, fragment: group.fragment, anchor: { kind: 'around', ordinal: 500 }, limit: 50 });
    expect(response.ordinals).toEqual(Array.from({ length: 50 }, (_, index) => 475 + index));
    expect(response.earlier).toEqual({ beforeOrdinal: 475, remaining: 474 });
    expect(response.later).toEqual({ afterOrdinal: 524, remaining: 476 });
  });

  test('filtered uses land on surrounding context while non-combined uses keep their exact address', () => {
    const store = create();
    const rows = stored([new BashToolUseMessage(at, 'first', 'true'), new AssistantMessage(at, 'Generic context'),
      new BashToolUseMessage(at, 'second', 'true')]);
    appendDisplayFrame(store, rows, rows.length, 'server');
    const filtered = new DisplayQuery(store, { ...profile, hiddenToolGroups: ['bash'] }, 3, [], false);
    expect(filtered.resolve(1, 3)).toEqual({ kind: 'filtered', ordinal: 1, landedOrdinal: 2 });
    expect(filtered.resolve(3, 3)).toEqual({ kind: 'filtered', ordinal: 3, landedOrdinal: 2 });
    expect(filtered.resolve(4, 3)).toEqual({ kind: 'missing', ordinal: 4, landedOrdinal: null });
    expect(new DisplayQuery(store, { ...profile, combine: false }, 3, [], false).resolve(3, 3))
      .toEqual({ kind: 'visible-row', ordinal: 3, landedOrdinal: 3 });
  });

  test('hiding all Bash rows certifies exhaustion without waiting for Bash classification', () => {
    const store = create();
    const rows = stored([new BashToolUseMessage(at, 'tool', 'true'), new ToolResultMessage(at, 'tool', 'Generic result')]);
    appendDisplayFrame(store, rows, rows.length, 'server');
    const input: DisplayWindowRequest = { chatId: 'chat', transcriptViewId: 'view', policyRevision: DISPLAY_POLICY_REVISION,
      profile: { ...profile, hiddenToolGroups: ['bash'] }, cuts: [], anchor: { kind: 'newest' }, limit: 50 };
    const certificate = displayCertificate('server', input, 2);
    const read = () => new DisplayQuery(store, input.profile, 2, [], true).window(input, certificate, 2, 2);
    const unclassified = parseDisplayWindowResponse(read());
    expect(unclassified).toMatchObject({ kind: 'available', certificate, items: [],
      earlier: { kind: 'exhausted-through-watermark' }, later: { kind: 'exhausted-through-watermark' } });
    while (prepareBashFrame(store, profile.bashRevision, [{ mode: 'glob', pattern: '*' }], 2) < 2) {}
    expect(read()).toEqual(unclassified);
  });

  test.each(['earlier', 'later'] as const)('traverses sparse filtered members %s without gaps, duplicates or crossing overlay cuts', direction => {
    const store = create();
    const messages: ChatMessage[] = [new UserMessage(at, 'Generic prompt')];
    const eligible: number[] = [];
    for (let index = 0; index < 137; index++) {
      if (index % 3 !== 0) eligible.push(messages.length + 1);
      messages.push(new BashToolUseMessage(at, `tool-${index}`, index % 3 === 0 ? 'skip' : 'keep'),
        new ToolResultMessage(at, `tool-${index}`, 'Generic result'));
    }
    messages.push(new AssistantMessage(at, 'Generic answer'));
    const rows = stored(messages);
    for (let offset = 0; offset < rows.length; offset += 17) {
      appendDisplayFrame(store, rows.slice(offset, offset + 17), rows.length, 'server');
    }
    const patterns = [{ mode: 'glob' as const, pattern: 'skip' }];
    while (prepareBashFrame(store, profile.bashRevision, patterns, rows.length) < rows.length) {}
    const cuts = [{ id: 'notice', afterOrdinal: 132, anchorRule: 'raw-position' as const }];
    const engine = new DisplayQuery(store, profile, rows.length, cuts, true);
    const request: DisplayWindowRequest = { chatId: 'chat', transcriptViewId: 'view', policyRevision: DISPLAY_POLICY_REVISION,
      profile, cuts, anchor: { kind: 'newest' }, limit: 50 };
    const certificate = displayCertificate('server', request, rows.length);
    const window = engine.window(request, certificate, rows.length, rows.length);
    const groups = window.items.filter(item => item.kind === 'tool-group');
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.count)).toEqual([44, 47]);

    for (const group of groups) {
      const expected = eligible.filter(ordinal => ordinal > group.fragment.after && ordinal <= group.fragment.through);
      const collected: number[] = [];
      let anchor: MemberWindowRequest['anchor'] = direction === 'later'
        ? { kind: 'first' } : { kind: 'around', ordinal: group.lastMember };
      let exhausted = false;
      for (let pages = 0; pages <= expected.length; pages++) {
        const page = parseMemberWindowResponse(engine.memberWindow({ certificate, profile, cuts,
          base: group.base, fragment: group.fragment, anchor, limit: 7 }));
        expect(page.certificate).toEqual(certificate);
        expect(page.ordinals.length).toBeGreaterThan(0);
        expect(page.ordinals.length).toBeLessThanOrEqual(7);
        const start = expected.indexOf(page.ordinals[0]);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(page.ordinals).toEqual(expected.slice(start, start + page.ordinals.length));
        expect(page.earlier).toEqual(start === 0 ? null : { beforeOrdinal: page.ordinals[0], remaining: start });
        const remaining = expected.length - start - page.ordinals.length;
        expect(page.later).toEqual(remaining === 0 ? null : { afterOrdinal: page.ordinals.at(-1), remaining });
        if (direction === 'later') collected.push(...page.ordinals);
        else collected.unshift(...page.ordinals);
        if (direction === 'later' && page.later) anchor = { kind: 'after', ordinal: page.later.afterOrdinal };
        else if (direction === 'earlier' && page.earlier) anchor = { kind: 'before', ordinal: page.earlier.beforeOrdinal };
        else { exhausted = true; break; }
      }
      expect(exhausted).toBe(true);
      expect(collected).toEqual(expected);
    }
  });
});
