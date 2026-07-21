import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forkJsonlTranscript, JsonlSourcePrefixChangedError } from '../fork-jsonl.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('forkJsonlTranscript', () => {
  it('preserves physical line positions and passes per-entry retained counts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(
      sourcePath,
      [
        JSON.stringify({ type: 'session', sessionId: 'source' }),
        '',
        JSON.stringify({ type: 'message', content: 'later physical entry' }),
        JSON.stringify({ type: 'message', content: 'selected entry' }),
        '',
      ].join('\n'),
    );

    const seen: Array<{
      type: unknown;
      retainedMessageCount: number | undefined;
    }> = [];
    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: 4,
      retainedMessageCounts: new Map([[4, 1]]),
      rewriteEntry(entry, context) {
        const record = entry as Record<string, unknown>;
        seen.push({
          type: record.type,
          retainedMessageCount: context.retainedMessageCount,
        });
        if (record.type === 'session') {
          return { ...record, sessionId: context.targetAgentSessionId };
        }
        return context.retainedMessageCount === 0 ? {} : entry;
      },
    });

    const lines = (await readFile(result.nativePath, 'utf8')).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('');
    expect(JSON.parse(lines[2]!)).toEqual({});
    expect(JSON.parse(lines[3]!)).toEqual({
      type: 'message',
      content: 'selected entry',
    });
    expect(seen).toEqual([
      { type: 'session', retainedMessageCount: 0 },
      { type: 'message', retainedMessageCount: 0 },
      { type: 'message', retainedMessageCount: 1 },
    ]);
  });

  it('allows source appends after the retained physical prefix', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    const retained = JSON.stringify({ type: 'message', content: 'selected' });
    await writeFile(sourcePath, `${retained}\n`);

    let appended = false;
    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: 1,
      rewriteEntry(entry) {
        if (!appended) {
          writeFileSync(
            sourcePath,
            [retained, JSON.stringify({ type: 'message', content: 'later' }), ''].join('\n'),
          );
          appended = true;
        }
        return entry;
      },
    });

    expect(await readFile(result.nativePath, 'utf8')).toBe(`${retained}\n`);
  });

  it.each([
    ['malformed', '{not-json}\n'],
    ['incomplete', '{"type":"message"'],
  ])('ignores %s output beyond the retained prefix', async (_kind, laterOutput) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    const retained = JSON.stringify({ type: 'message', content: 'selected' });
    await writeFile(sourcePath, `${retained}\n${laterOutput}`);

    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: 1,
    });

    expect(await readFile(result.nativePath, 'utf8')).toBe(`${retained}\n`);
  });

  it('rejects removal of the retained line terminator', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    const retained = JSON.stringify({ type: 'message', content: 'selected' });
    await writeFile(sourcePath, `${retained}\n`);

    await expect(
      forkJsonlTranscript({
        sourcePath,
        sourceAgentSessionId: 'source',
        cutoffLine: 1,
        rewriteEntry(entry) {
          writeFileSync(sourcePath, retained);
          return entry;
        },
      }),
    ).rejects.toBeInstanceOf(JsonlSourcePrefixChangedError);
  });

  it('allows an unterminated retained line to gain an append-only separator', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    const retained = JSON.stringify({ type: 'message', content: 'selected' });
    await writeFile(sourcePath, retained);

    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: 1,
      rewriteEntry(entry) {
        writeFileSync(sourcePath, `${retained}\n${JSON.stringify({ type: 'message' })}\n`);
        return entry;
      },
    });

    expect(await readFile(result.nativePath, 'utf8')).toBe(`${retained}\n`);
  });

  it('rejects extending an unterminated retained line before its separator', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    const retained = JSON.stringify({ type: 'message', content: 'selected' });
    await writeFile(sourcePath, retained);

    await expect(
      forkJsonlTranscript({
        sourcePath,
        sourceAgentSessionId: 'source',
        cutoffLine: 1,
        rewriteEntry(entry) {
          writeFileSync(sourcePath, `${retained} `);
          return entry;
        },
      }),
    ).rejects.toBeInstanceOf(JsonlSourcePrefixChangedError);
  });

  it.each([
    ['truncated retained-prefix', (sourcePath: string) => writeFileSync(sourcePath, '')],
    ['deleted retained-prefix', (sourcePath: string) => rmSync(sourcePath)],
    [
      'retained-prefix with invalid JSON',
      (sourcePath: string) => writeFileSync(sourcePath, '{invalid}\n'),
    ],
  ])('maps a %s source to a revision change and cleans the target', async (_kind, mutate) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, `${JSON.stringify({ type: 'message' })}\n`);

    await expect(
      forkJsonlTranscript({
        sourcePath,
        sourceAgentSessionId: 'source',
        cutoffLine: 1,
        rewriteEntry(entry) {
          mutate(sourcePath);
          return entry;
        },
      }),
    ).rejects.toBeInstanceOf(JsonlSourcePrefixChangedError);

    expect((await readdir(root)).filter((name) => name !== 'source.jsonl')).toEqual([]);
  });

  it('preserves an initial source read failure', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);

    await expect(
      forkJsonlTranscript({
        sourcePath: path.join(root, 'missing.jsonl'),
        sourceAgentSessionId: 'source',
        cutoffLine: 1,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a rendered entry mutation inside the retained physical prefix', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    const original = JSON.stringify({ type: 'message', content: 'selected' });
    await writeFile(sourcePath, `${original}\n`);

    await expect(
      forkJsonlTranscript({
        sourcePath,
        sourceAgentSessionId: 'source',
        cutoffLine: 1,
        rewriteEntry(entry) {
          writeFileSync(sourcePath, `${JSON.stringify({ type: 'message', content: 'changed' })}\n`);
          return entry;
        },
      }),
    ).rejects.toBeInstanceOf(JsonlSourcePrefixChangedError);
  });

  it('rejects a non-rendered native entry mutation inside the retained physical prefix', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    const session = JSON.stringify({ type: 'session_meta', cwd: '/before' });
    const message = JSON.stringify({ type: 'message', content: 'selected' });
    await writeFile(sourcePath, `${session}\n${message}\n`);

    let mutated = false;
    await expect(
      forkJsonlTranscript({
        sourcePath,
        sourceAgentSessionId: 'source',
        cutoffLine: 2,
        rewriteEntry(entry) {
          if (!mutated) {
            writeFileSync(
              sourcePath,
              `${JSON.stringify({
                type: 'session_meta',
                cwd: '/after',
              })}\n${message}\n`,
            );
            mutated = true;
          }
          return entry;
        },
      }),
    ).rejects.toBeInstanceOf(JsonlSourcePrefixChangedError);
  });
});
