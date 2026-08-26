import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HandoffCliCommand } from '../args.js';
import { runChatHandoff } from '../chat-handoff.js';

const CHAT_ID = '1785337200123456';
const DOCUMENT = '<handoff-artifact/>\n';
const roots: string[] = [];
const baseCommand: HandoffCliCommand = {
  kind: 'handoff',
  workspace: 'default',
  configDir: '/config',
  chatId: CHAT_ID,
  contextWindowTokens: 131_072,
  force: false,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runChatHandoff', () => {
  test('writes only the XML document to stdout', async () => {
    const capture = output();

    await runChatHandoff(baseCommand, client(), capture);

    expect(capture.documents).toEqual([DOCUMENT]);
    expect(capture.results).toEqual([]);
  });

  test('publishes mode 0600 and prints a complete read-only receipt', async () => {
    const root = await temporaryRoot();
    const target = path.join(root, 'handoff.xml');
    const capture = output();

    await runChatHandoff({ ...baseCommand, outputPath: target }, client(), capture);

    expect(await readFile(target, 'utf8')).toBe(DOCUMENT);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(capture.documents).toEqual([]);
    expect(capture.results).toHaveLength(1);
    const receipt = capture.results[0]!;
    expect(receipt).toContain('operation: read-only handoff artifact');
    expect(receipt).toContain(`output: ${target}`);
    expect(receipt).toContain('context window: 131072 tokens');
    expect(receipt).toContain('usable artifact budget: 98304 tokens (75%; usage estimated)');
    expect(receipt).toContain('fold: handoff-v1');
    expect(receipt).toContain('source export entries: 8');
    expect(receipt).toContain('eligible entries: 5');
    expect(receipt).toContain('fixed-fold excluded entries: 3 (diagnostics 3)');
    expect(receipt).toContain('included eligible entries: 2');
    expect(receipt).toContain('budget-omitted eligible entries: 3');
    expect(receipt).toContain('abridged included entries: 1');
    expect(receipt).toContain('gaps: 2 (eligible entries only)');
    expect(receipt).toContain('projection truncated: yes');
    expect(receipt).toContain(`code units: ${DOCUMENT.length}`);
    expect(receipt).toContain(`bytes: ${new TextEncoder().encode(DOCUMENT).byteLength}`);
    expect(receipt).toContain(
      `sha256: ${crypto.createHash('sha256').update(DOCUMENT).digest('hex')}`,
    );
    await expect((await import('node:fs/promises')).readdir(root)).resolves.toEqual([
      'handoff.xml',
    ]);
  });

  test('refuses an existing output before the request and permits force', async () => {
    const root = await temporaryRoot();
    const target = path.join(root, 'handoff.xml');
    await writeFile(target, 'old');
    let calls = 0;
    const remote = client(() => { calls += 1; });

    await expect(runChatHandoff(
      { ...baseCommand, outputPath: target },
      remote,
      output(),
    )).rejects.toMatchObject({ phase: 'arguments', exitCode: 2 });
    expect(calls).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('old');

    await runChatHandoff(
      { ...baseCommand, outputPath: target, force: true },
      remote,
      output(),
    );
    expect(calls).toBe(1);
    expect(await readFile(target, 'utf8')).toBe(DOCUMENT);
  });

  test('refuses an output created during the request and removes the temporary file', async () => {
    const removed: string[] = [];
    const fileSystem = {
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      writeFile: async () => undefined,
      link: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      rename: async () => undefined,
      rm: async (target: string) => { removed.push(target); },
      randomUUID: () => 'temporary-id',
    };

    await expect(runChatHandoff(
      { ...baseCommand, outputPath: '/workspace/handoff.xml' },
      client(),
      output(),
      undefined,
      fileSystem,
    )).rejects.toMatchObject({ phase: 'arguments', exitCode: 2 });
    expect(removed).toEqual(['/workspace/.handoff.xml.garcon-handoff-temporary-id.tmp']);
  });

  test('aborts before publication and removes the temporary file', async () => {
    const controller = new AbortController();
    const published: string[] = [];
    const removed: string[] = [];
    const fileSystem = {
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      writeFile: async () => { controller.abort(new Error('cancelled')); },
      link: async (_source: string, destination: string) => { published.push(destination); },
      rename: async (_source: string, destination: string) => { published.push(destination); },
      rm: async (target: string) => { removed.push(target); },
      randomUUID: () => 'temporary-id',
    };

    await expect(runChatHandoff(
      { ...baseCommand, outputPath: '/workspace/handoff.xml' },
      client(),
      output(),
      controller.signal,
      fileSystem,
    )).rejects.toThrow('cancelled');
    expect(published).toEqual([]);
    expect(removed).toEqual(['/workspace/.handoff.xml.garcon-handoff-temporary-id.tmp']);
  });
});

function client(onCall: () => void = () => undefined) {
  return {
    async getChatHandoffArtifact() {
      onCall();
      return response();
    },
  };
}

function response() {
  return {
    success: true as const,
    chatId: CHAT_ID,
    transcriptViewId: 'view-1',
    lastOrdinal: 8,
    generatedAt: '2026-08-26T00:00:00.000Z',
    contextWindowTokens: 131_072,
    usableTokenBudget: 98_304,
    estimatedTokens: 20,
    fold: 'handoff-v1' as const,
    gapUnit: 'eligible-entry' as const,
    sourceEntryCount: 8,
    eligibleEntryCount: 5,
    excludedEntryCounts: [{ category: 'diagnostics' as const, count: 3 }],
    includedEntryCount: 2,
    budgetOmittedEntryCount: 3,
    abridgedEntryCount: 1,
    gapCount: 2,
    projectionTruncated: true,
    documentCodeUnits: DOCUMENT.length,
    document: DOCUMENT,
  };
}

function output() {
  const documents: string[] = [];
  const results: string[] = [];
  return {
    documents,
    results,
    document(content: string) { documents.push(content); },
    result(content: string) { results.push(content); },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-cli-handoff-'));
  roots.push(root);
  return root;
}
