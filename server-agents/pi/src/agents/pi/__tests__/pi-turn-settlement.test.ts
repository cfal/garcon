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
  expected: readonly (readonly [string, number])[];
  nativePath: string;
  steeringUnresolved?: boolean;
}): PiTurnSettlementRecord {
  return {
    steeringUnresolved: input.steeringUnresolved ?? false,
    baseline: input.baseline,
    expected: new Map(input.expected),
    nativePath: input.nativePath,
  };
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
      expected: [['user', 1], ['assistant', 1]],
      nativePath: file,
    });

    // The file still holds only the equal-content occurrences from before the
    // turn, so nothing this turn produced has persisted.
    await expect(verifyPiTurnSettlement(settlement)).resolves.toBe('unresolved');

    await writeEntries(file, [
      { id: 'old-user', role: 'user', content: 'same text' },
      { id: 'old-assistant', role: 'assistant', content: [{ type: 'text', text: 'same text' }] },
      { id: 'new-user', role: 'user', content: 'same text' },
      { id: 'new-assistant', role: 'assistant', content: [{ type: 'text', text: 'same text' }] },
    ]);
    await expect(verifyPiTurnSettlement(settlement)).resolves.toBe('confirmed');
  });

  it('counts tool-only and tool-result occurrences without rendered content', async () => {
    const file = await sessionFile();
    await writeEntries(file, []);
    const baseline = await snapshotPiSettlementBaseline(file);
    const settlement = record({
      baseline,
      expected: [['user', 1], ['assistant', 1], ['toolResult', 1]],
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
    await expect(verifyPiTurnSettlement(settlement)).resolves.toBe('unresolved');

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
    await expect(verifyPiTurnSettlement(settlement)).resolves.toBe('confirmed');
  });

  it('stays unresolved when the baseline could not identify existing entries', async () => {
    const file = await sessionFile();
    await writeEntries(file, [{ role: 'user', content: 'unidentified occurrence' }]);
    const baseline = await snapshotPiSettlementBaseline(file);
    expect(baseline.kind).toBe('unavailable');

    const settlement = record({
      baseline,
      expected: [['user', 1]],
      nativePath: file,
    });
    await writeEntries(file, [
      { role: 'user', content: 'unidentified occurrence' },
      { id: 'new-user', role: 'user', content: 'unidentified occurrence' },
    ]);
    // Growth cannot be attributed without a fully identified baseline.
    await expect(verifyPiTurnSettlement(settlement)).resolves.toBe('unresolved');
  });

  it('treats a missing file as a genuinely empty baseline', async () => {
    const file = await sessionFile();
    const baseline = await snapshotPiSettlementBaseline(file);
    expect(baseline).toEqual({ kind: 'ready', entryIds: new Set() });

    const settlement = record({ baseline, expected: [['user', 1]], nativePath: file });
    await expect(verifyPiTurnSettlement(settlement)).resolves.toBe('unresolved');
    await writeEntries(file, [{ id: 'first-user', role: 'user', content: 'hello' }]);
    await expect(verifyPiTurnSettlement(settlement)).resolves.toBe('confirmed');
  });

  it('requires nothing when the turn finalized no occurrences', async () => {
    const settlement = record({
      baseline: { kind: 'unavailable' },
      expected: [],
      nativePath: '/nonexistent',
    });
    await expect(verifyPiTurnSettlement(settlement)).resolves.toBe('confirmed');
    addExpectedNativeMessage(settlement.expected as Map<string, number>, 'assistant');
    await expect(verifyPiTurnSettlement(settlement)).resolves.toBe('unresolved');
  });
});
