import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExportCliCommand } from '../args.js';
import { runChatExport } from '../chat-export.js';
import { CliError } from '../errors.js';

const CHAT_ID = '1785337200123456';
const roots: string[] = [];
const baseCommand: ExportCliCommand = {
  kind: 'export',
  workspace: 'default',
  configDir: '/config',
  chatId: CHAT_ID,
  format: 'markdown',
  exclusions: ['tool-calls'],
  force: false,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runChatExport', () => {
  test('writes only the document to stdout when no output path is supplied', async () => {
    const capture = output();
    await runChatExport(baseCommand, client(), capture);

    expect(capture.documents).toEqual(['# Export\n']);
    expect(capture.results).toEqual([]);
  });

  test('writes atomically to a file and prints a receipt', async () => {
    const root = await temporaryRoot();
    const target = path.join(root, 'transcript.md');
    const capture = output();

    await runChatExport({ ...baseCommand, outputPath: target }, client(), capture);

    expect(await readFile(target, 'utf8')).toBe('# Export\n');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(capture.documents).toEqual([]);
    expect(capture.results[0]).toContain(`output: ${target}`);
    expect(capture.results[0]).toContain('bytes: 9');
    await expect((await import('node:fs/promises')).readdir(root)).resolves.toEqual(['transcript.md']);
  });

  test('refuses overwrite before requesting the server and allows explicit force', async () => {
    const root = await temporaryRoot();
    const target = path.join(root, 'transcript.md');
    await writeFile(target, 'old');
    let calls = 0;
    const remote = client(() => { calls += 1; });

    await expect(runChatExport({ ...baseCommand, outputPath: target }, remote, output()))
      .rejects.toMatchObject({ phase: 'arguments', exitCode: 2 });
    expect(calls).toBe(0);
    expect(await readFile(target, 'utf8')).toBe('old');

    await runChatExport({ ...baseCommand, outputPath: target, force: true }, remote, output());
    expect(calls).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('# Export\n');
  });

  test('refuses a destination created during export without force', async () => {
    const removed: string[] = [];
    const fileSystem = {
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      writeFile: async () => undefined,
      link: async () => { throw Object.assign(new Error('exists'), { code: 'EEXIST' }); },
      rename: async () => undefined,
      rm: async (target: string) => { removed.push(target); },
      randomUUID: () => 'temporary-id',
    };

    await expect(runChatExport(
      { ...baseCommand, outputPath: '/workspace/transcript.md' },
      client(),
      output(),
      undefined,
      fileSystem,
    )).rejects.toMatchObject({ phase: 'arguments', exitCode: 2 });
    expect(removed).toEqual(['/workspace/.transcript.md.garcon-export-temporary-id.tmp']);
  });

  test('removes the sibling temporary file when atomic publication fails', async () => {
    const removed: string[] = [];
    const fileSystem = {
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      writeFile: async () => undefined,
      link: async () => { throw new Error('link failed'); },
      rename: async () => undefined,
      rm: async (target: string) => { removed.push(target); },
      randomUUID: () => 'temporary-id',
    };

    await expect(runChatExport(
      { ...baseCommand, outputPath: '/workspace/transcript.md' },
      client(),
      output(),
      undefined,
      fileSystem,
    )).rejects.toBeInstanceOf(CliError);
    expect(removed).toEqual(['/workspace/.transcript.md.garcon-export-temporary-id.tmp']);
  });

  test('explains when atomic no-overwrite publication is unsupported', async () => {
    const fileSystem = {
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      writeFile: async () => undefined,
      link: async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); },
      rename: async () => undefined,
      rm: async () => undefined,
      randomUUID: () => 'temporary-id',
    };

    await expect(runChatExport(
      { ...baseCommand, outputPath: '/workspace/transcript.md' },
      client(),
      output(),
      undefined,
      fileSystem,
    )).rejects.toMatchObject({
      phase: 'export',
      exitCode: 3,
      message: expect.stringContaining('use --force or choose a different destination'),
    });
  });
});

function client(onCall: () => void = () => undefined) {
  return {
    async getTranscriptExport() {
      onCall();
      return {
        success: true as const,
        chatId: CHAT_ID,
        format: 'markdown' as const,
        transcriptViewId: 'view-1',
        lastOrdinal: 3,
        generatedAt: '2026-08-23T00:00:00.000Z',
        entryCount: 1,
        totalEntryCount: 2,
        exclusions: ['tool-calls'] as const,
        omitted: [{ category: 'tool-calls' as const, count: 1 }],
        document: '# Export\n',
      };
    },
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-cli-export-'));
  roots.push(root);
  return root;
}
