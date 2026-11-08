import { expect, test } from 'bun:test';
import { displayCutsKey, displayProfileKey, parseBodyDependencyRequest, parseBodyDependencyResponse,
  parseDisplayDescriptor, parseDisplayWindowRequest, parseDisplayWindowResponse, parseMemberWindowRequest,
  parseMemberWindowResponse } from '../transcript-display-contract.ts';
import { parseSubagentSummaryPage } from '../transcript-display-auxiliary.ts';

const profile = { combine: true, showThinking: true, hiddenToolGroups: [], bashRevision: 'revision' };

test('canonicalizes same-anchor cuts by code units, independent of locale', () => {
  const cuts = ['a', 'Z', 'A', 'z', '_'].map(id => ({ id, afterOrdinal: 3, anchorRule: 'raw-position' }));
  const ordered = [...cuts].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  expect(displayCutsKey(cuts)).toBe(displayCutsKey(ordered));
  expect(JSON.parse(displayCutsKey(cuts)).map(cut => cut[0])).toEqual(['A', 'Z', '_', 'a', 'z']);
});
const certificate = { serverInstanceId: 'server', chatId: 'chat', transcriptViewId: 'view', policyRevision: 1,
  profileKey: displayProfileKey(profile), bashRevision: 'revision', watermark: 10, cutsKey: displayCutsKey([]) };
const request = { chatId: 'chat', transcriptViewId: 'view', policyRevision: 1, profile, cuts: [], limit: 50, anchor: { kind: 'newest' } };
const group = { kind: 'tool-group', base: { afterBreaker: 0, beforeBreaker: 11, firstMember: 1, lastMember: 10, openAtWatermark: true },
  fragment: { after: 0, through: 10 }, firstMember: 1, lastMember: 10, count: 10,
  totals: { commands: 10, fileReads: 0, fileEdits: 0, other: 0 }, categoryOrder: ['commands'] };
const window = { kind: 'available', certificate, sourceHead: 10, structuralPreparedThrough: 10, bashPreparedThrough: 10,
  interval: { after: 0, through: 10 }, items: [group], earlier: { kind: 'exhausted-through-watermark' },
  later: { kind: 'exhausted-through-watermark' }, cutPlacements: [], publicTail: null };

test('[TLV5-DISPLAY.01-CONTRACT-01] round trips a certified aggregate without member identities or bodies', () => {
  expect(parseDisplayWindowRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  expect(parseDisplayWindowResponse(JSON.parse(JSON.stringify(window)))).toEqual(window);
});

test('rejects unsafe counts, unknown categories, reversed intervals and unknown rendered types', () => {
  for (const changed of [{ count: Number.MAX_SAFE_INTEGER + 1 }, { count: 11 }, { firstMember: 11 },
    { categoryOrder: ['commands', 'commands'] }, { fragment: { after: 5, through: 4 } }]) {
    expect(() => parseDisplayDescriptor({ ...group, ...changed })).toThrow(TypeError);
  }
  expect(() => parseDisplayDescriptor({ kind: 'row', ordinal: 1, messageType: 'unrecognized', layout: 'standard',
    estimatedBodyBytes: 0, permissionOccurrenceId: null })).toThrow(TypeError);
  expect(() => parseDisplayWindowResponse({ ...window, items: [group, group] })).toThrow(TypeError);
  expect(() => parseDisplayWindowResponse({ ...window, certificate: { ...certificate, watermark: 9 } })).toThrow(TypeError);
});

test('[TLV5-L08.01-CONTRACT-01] rejects foreign profile, view, watermark and cut cursors', () => {
  for (const changed of [{ profileKey: 'wrong' }, { cutsKey: 'wrong' }, { transcriptViewId: 'foreign' }, { bashRevision: 'old' }]) {
    expect(() => parseDisplayWindowRequest({ ...request, anchor: { kind: 'before', cursor: {
      certificate: { ...certificate, ...changed }, boundaryOrdinal: 10 } } })).toThrow(TypeError);
  }
  expect(() => parseDisplayWindowRequest({ ...request, profile: { ...profile, hiddenToolGroups: ['bash', 'bash'] } })).toThrow(TypeError);
  expect(() => parseDisplayWindowRequest({ ...request, cuts: Array(33).fill({ id: 'cut', afterOrdinal: 1, anchorRule: 'raw-position' }) })).toThrow(TypeError);
  expect(() => parseDisplayWindowRequest({ ...request, anchor: { kind: 'before', cursor: { certificate, boundaryOrdinal: 0 } } })).toThrow(TypeError);
  expect(parseDisplayWindowRequest({ ...request, anchor: { kind: 'after', cursor: { certificate, boundaryOrdinal: 0 } } }).anchor.cursor.boundaryOrdinal).toBe(0);
});

test('bounds member requests inside the certified fragment', () => {
  const members = { certificate, profile, cuts: [], base: group.base, fragment: group.fragment, limit: 50, anchor: { kind: 'first' } };
  expect(parseMemberWindowRequest(members)).toEqual(members);
  expect(() => parseMemberWindowRequest({ ...members, fragment: { after: 0, through: 11 } })).toThrow(TypeError);
  expect(() => parseMemberWindowRequest({ ...members, anchor: { kind: 'around', ordinal: 12 } })).toThrow(TypeError);
  const individualProfile = { ...profile, combine: false };
  expect(() => parseMemberWindowRequest({ ...members, profile: individualProfile,
    certificate: { ...certificate, profileKey: displayProfileKey(individualProfile) } })).toThrow(TypeError);
});

test('rejects malformed member pages rather than accepting ambiguous pagination', () => {
  const members = { certificate, base: group.base, fragment: group.fragment, ordinals: [3, 5, 7],
    earlier: { beforeOrdinal: 3, remaining: 1 }, later: { afterOrdinal: 7, remaining: 2 } };
  expect(parseMemberWindowResponse(JSON.parse(JSON.stringify(members)))).toEqual(members);
  for (const changed of [
    { ordinals: [3, 3, 7] },
    { ordinals: [7, 5, 3], earlier: { beforeOrdinal: 7, remaining: 1 }, later: { afterOrdinal: 3, remaining: 2 } },
    { ordinals: [0, 5, 7], earlier: null }, { ordinals: [3, 5, 11], later: null },
    { fragment: { after: 3, through: 10 }, earlier: null }, { fragment: { after: 0, through: 6 }, later: null },
    { earlier: { beforeOrdinal: 2, remaining: 1 } }, { later: { afterOrdinal: 8, remaining: 2 } },
    { earlier: { beforeOrdinal: 3, remaining: 0 } },
    { fragment: { after: 0, through: 11 } }, { certificate: { ...certificate, watermark: 9 } },
  ]) {
    expect(() => parseMemberWindowResponse({ ...members, ...changed })).toThrow(TypeError);
  }
  const exhausted = { ...members, ordinals: [], earlier: null, later: null };
  expect(parseMemberWindowResponse(exhausted)).toEqual(exhausted);
  expect(() => parseMemberWindowResponse({ ...exhausted, earlier: members.earlier })).toThrow(TypeError);
  expect(() => parseMemberWindowResponse({ ...exhausted, later: members.later })).toThrow(TypeError);
});

test('bounds hydration addresses and rejects future evidence and conflicting outcomes', () => {
  const bodies = { certificate, profile, cuts: [], seedOrdinals: [1], residentOrdinals: [], limitBodies: 10, estimatedByteBudget: 1000 };
  expect(parseBodyDependencyRequest(bodies)).toEqual(bodies);
  expect(() => parseBodyDependencyRequest({ ...bodies, seedOrdinals: [11] })).toThrow(TypeError);
  expect(() => parseBodyDependencyRequest({ ...bodies, seedOrdinals: Array(51).fill(1) })).toThrow(TypeError);
  const response = { certificate, details: [{ ordinal: 1, pairedUse: 1, pairedResult: 11, questionWrapper: null, permissionTerminal: null, commandFormat: null }],
    bodies: [], deferredOrdinals: [], nonRenderedOrdinals: [], oversizedOrdinal: null };
  expect(() => parseBodyDependencyResponse(response)).toThrow(TypeError);
  expect(() => parseBodyDependencyResponse({ ...response, details: [], deferredOrdinals: [1], nonRenderedOrdinals: [1] })).toThrow(TypeError);
});

test.each(['model', 'path', 'message', 'lastActionLabel'])('bounds optional subagent %s previews without rejecting empty strings', (key) => {
  const entry = { id: 'agent', kind: 'subagent', name: 'Worker', status: 'idle', statusLabel: 'Idle', anchorOrdinal: 1 };
  const page = { kind: 'available', serverInstanceId: 'server', chatId: 'chat', transcriptViewId: 'view',
    watermark: 1, sourceHead: 1, nextAfterOrder: null };
  for (const value of [undefined, '', 'x'.repeat(300)]) {
    const parsed = parseSubagentSummaryPage({ ...page, entries: [{ ...entry, [key]: value }] });
    expect(parsed.entries[0][key]).toBe(value);
  }
  for (const value of [null, false, 0, {}, 'x'.repeat(301)]) {
    expect(() => parseSubagentSummaryPage({ ...page, entries: [{ ...entry, [key]: value }] })).toThrow('Invalid subagent preview');
  }
});
