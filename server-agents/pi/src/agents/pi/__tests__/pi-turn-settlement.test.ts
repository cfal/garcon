import { afterEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  addExpectedNativeMessage,
  snapshotPiSettlementBaseline,
  verifyPiTurnSettlement,
} from '../pi-turn-settlement.js';
import type { PiTurnSettlementRecord } from '../pi-rpc-session-state.js';

const temporaryFiles: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryFiles.splice(0).map((file) => fs.rm(file, { force: true })));
});

async function sessionFile(): Promise<string> {
  const file = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'pi-settlement-')),
    'session.jsonl',
  );
  temporaryFiles.push(file);
  return file;
}

interface RawEntry {
  readonly id?: string;
  readonly role: string;
  readonly content: unknown;
}

async function writeEntries(file: string, entries: readonly RawEntry[]): Promise<void> {
  const rows = [
    { type: 'session', version: 3, id: 'session-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' },
    ...entries.map((entry, index) => ({
      type: 'message',
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      parentId: index === 0 ? null : `prior-${index}`,
      timestamp: `2026-01-01T00:00:0${index}.000Z`,
      message: { role: entry.role, content: entry.content, timestamp: 1767225600000 + index },
    })),
  ];
  await fs.writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

function record(input: {
  baseline: PiTurnSettlementRecord['baseline'];
  expected: readonly string[];
  nativePath: string;
  steeringUnresolved?: boolean;
  turnId?: string;
}): PiTurnSettlementRecord {
  return {
    steeringUnresolved: input.steeringUnresolved ?? false,
    baseline: input.baseline,
    expected: [...input.expected],
    nativePath: input.nativePath,
    turnId: input.turnId ?? null,
  };
}

async function verdictOf(settlement: PiTurnSettlementRecord): Promise<'confirmed' | 'unresolved'> {
  return (await verifyPiTurnSettlement(settlement)).verdict;
}

describe('pi turn settlement evidence', () => {
  it('never lets a pre-existing equal-content occurrence satisfy the proof', async () => {
    const file = await sessionFile();
    await writeEntries(file, [
      { id: 'old-user', role: 'user', content: 'same text' },
      { id: 'old-assistant', role: 'assistant', content: [{ type: 'text', text: 'same text' }] },
    ]);
    const baseline = await snapshotPiSettlementBaseline(file);
    const settlement = record({
      baseline,
      expected: ['user', 'assistant'],
      nativePath: file,
    });

    // The file still holds only the equal-content occurrences from before the
    // turn, so nothing this turn produced has persisted.
    await expect(verdictOf(settlement)).resolves.toBe('unresolved');

    await writeEntries(file, [
      { id: 'old-user', role: 'user', content: 'same text' },
      { id: 'old-assistant', role: 'assistant', content: [{ type: 'text', text: 'same text' }] },
      { id: 'new-user', role: 'user', content: 'same text' },
      { id: 'new-assistant', role: 'assistant', content: [{ type: 'text', text: 'same text' }] },
    ]);
    await expect(verdictOf(settlement)).resolves.toBe('confirmed');
  });

  it('counts tool-only and tool-result occurrences without rendered content', async () => {
    const file = await sessionFile();
    await writeEntries(file, []);
    const baseline = await snapshotPiSettlementBaseline(file);
    const settlement = record({
      baseline,
      expected: ['user', 'assistant', 'toolResult'],
      nativePath: file,
    });

    await writeEntries(file, [
      { id: 'turn-user', role: 'user', content: 'run the tool' },
      {
        id: 'turn-assistant',
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'true' } }],
      },
    ]);
    // The tool result has not persisted yet.
    await expect(verdictOf(settlement)).resolves.toBe('unresolved');

    await writeEntries(file, [
      { id: 'turn-user', role: 'user', content: 'run the tool' },
      {
        id: 'turn-assistant',
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'true' } }],
      },
      {
        id: 'turn-result',
        role: 'toolResult',
        content: [{ type: 'text', text: '' }],
      },
    ]);
    await expect(verdictOf(settlement)).resolves.toBe('confirmed');
  });

  it('stays unresolved when the baseline could not identify existing entries', async () => {
    const file = await sessionFile();
    await writeEntries(file, [{ role: 'user', content: 'unidentified occurrence' }]);
    const baseline = await snapshotPiSettlementBaseline(file);
    expect(baseline.kind).toBe('unavailable');

    const settlement = record({
      baseline,
      expected: ['user'],
      nativePath: file,
    });
    await writeEntries(file, [
      { role: 'user', content: 'unidentified occurrence' },
      { id: 'new-user', role: 'user', content: 'unidentified occurrence' },
    ]);
    // Growth cannot be attributed without a fully identified baseline.
    await expect(verdictOf(settlement)).resolves.toBe('unresolved');
  });

  it('treats a missing file as a genuinely empty baseline', async () => {
    const file = await sessionFile();
    const baseline = await snapshotPiSettlementBaseline(file);
    expect(baseline).toEqual({ kind: 'ready', entryIds: new Set() });

    const settlement = record({ baseline, expected: ['user'], nativePath: file });
    await expect(verdictOf(settlement)).resolves.toBe('unresolved');
    await writeEntries(file, [{ id: 'first-user', role: 'user', content: 'hello' }]);
    await expect(verdictOf(settlement)).resolves.toBe('confirmed');
  });

  it('requires nothing when the turn finalized no occurrences', async () => {
    const settlement = record({
      baseline: { kind: 'unavailable' },
      expected: [],
      nativePath: '/nonexistent',
    });
    await expect(verdictOf(settlement)).resolves.toBe('confirmed');
    addExpectedNativeMessage(settlement.expected as string[], 'assistant');
    await expect(verdictOf(settlement)).resolves.toBe('unresolved');
  });

  it('rejects reversed roles and lets interposed rows only extend, not substitute', async () => {
    const file = await sessionFile();
    await writeEntries(file, []);
    const baseline = await snapshotPiSettlementBaseline(file);
    const settlement = record({
      baseline,
      expected: ['user', 'assistant'],
      nativePath: file,
    });

    // Reversed provider order cannot satisfy the expected sequence.
    await writeEntries(file, [
      { id: 'new-assistant', role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      { id: 'new-user', role: 'user', content: 'u' },
    ]);
    await expect(verdictOf(settlement)).resolves.toBe('unresolved');

    // Interposed provider entries are tolerated around the ordered sequence.
    await writeEntries(file, [
      { id: 'extra-1', role: 'toolResult', content: [{ type: 'text', text: '' }] },
      { id: 'new-user', role: 'user', content: 'u' },
      { id: 'extra-2', role: 'toolResult', content: [{ type: 'text', text: '' }] },
      { id: 'new-assistant', role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    ]);
    await expect(verdictOf(settlement)).resolves.toBe('confirmed');
  });

  it('requires each equal-role adjacent occurrence separately', async () => {
    const file = await sessionFile();
    await writeEntries(file, []);
    const baseline = await snapshotPiSettlementBaseline(file);
    const settlement = record({
      baseline,
      expected: ['assistant', 'assistant'],
      nativePath: file,
    });
    await writeEntries(file, [
      { id: 'only-one', role: 'assistant', content: [{ type: 'text', text: 'same' }] },
    ]);
    await expect(verdictOf(settlement)).resolves.toBe('unresolved');
    await writeEntries(file, [
      { id: 'only-one', role: 'assistant', content: [{ type: 'text', text: 'same' }] },
      { id: 'second', role: 'assistant', content: [{ type: 'text', text: 'same' }] },
    ]);
    await expect(verdictOf(settlement)).resolves.toBe('confirmed');
  });

  it('binds each live occurrence identity to its proven native entry in file order', async () => {
    const file = await sessionFile();
    await writeEntries(file, [
      { id: 'prior-user', role: 'user', content: 'earlier' },
    ]);
    const baseline = await snapshotPiSettlementBaseline(file);
    const settlement = record({
      baseline,
      expected: ['user', 'assistant', 'toolResult', 'assistant'],
      nativePath: file,
      turnId: 'turn-9',
    });
    await writeEntries(file, [
      { id: 'prior-user', role: 'user', content: 'earlier' },
      { id: 'new-user', role: 'user', content: 'go' },
      { id: 'new-a1', role: 'assistant', content: [{ type: 'text', text: 'first' }] },
      { id: 'new-result', role: 'toolResult', content: [{ type: 'text', text: '' }] },
      { id: 'new-a2', role: 'assistant', content: [{ type: 'text', text: 'second' }] },
    ]);
    const proof = await verifyPiTurnSettlement(settlement);
    expect(proof.verdict).toBe('confirmed');
    expect([...proof.itemAliases!]).toEqual([
      ['turn:turn-9:end:0', 'new-user'],
      ['turn:turn-9:end:1', 'new-a1'],
      ['turn:turn-9:end:2', 'new-result'],
      ['turn:turn-9:end:3', 'new-a2'],
    ]);
  });

  it('rejects duplicate native entry ids as ambiguous evidence', async () => {
    const file = await sessionFile();
    await writeEntries(file, []);
    const baseline = await snapshotPiSettlementBaseline(file);
    const settlement = record({ baseline, expected: ['user'], nativePath: file });
    await writeEntries(file, [
      { id: 'dup', role: 'user', content: 'u' },
      { id: 'dup', role: 'user', content: 'u' },
    ]);
    await expect(verdictOf(settlement)).resolves.toBe('unresolved');
  });
});
