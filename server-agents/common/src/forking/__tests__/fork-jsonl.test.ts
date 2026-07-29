import { afterEach, describe, expect, it } from 'bun:test';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { forkJsonlTranscript, JsonlSourcePrefixChangedError } from '../fork-jsonl.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('forkJsonlTranscript', () => {
  it('transforms a selected snapshot with access to the immutable full source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, [
      JSON.stringify({ type: 'message', value: 'selected' }),
      JSON.stringify({ type: 'metadata', value: 'full-source' }),
      '',
    ].join('\n'));

    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: 1,
      transformEntries(input) {
        expect(input.selectedEntries).toEqual([{ type: 'message', value: 'selected' }]);
        expect(input.sourceEntries).toHaveLength(2);
        return {
          entries: [{ type: 'message', sessionId: input.targetAgentSessionId }],
          expectedSemanticDigest: 'semantic-digest',
        };
      },
    });

    expect(JSON.parse((await readFile(result.nativePath, 'utf8')).trim())).toEqual({
      type: 'message',
      sessionId: result.agentSessionId,
    });
    expect(result.expectedSemanticDigest).toBe('semantic-digest');
    expect((await stat(result.nativePath)).mode & 0o777).toBe(0o600);
  });

  it('uses a provider-supplied target path without changing the default session id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, `${JSON.stringify({ type: 'message', value: 'source' })}\n`);
    let received: {
      sourcePath: string;
      targetAgentSessionId: string;
      createdAt: Date;
    } | null = null;

    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: null,
      createTargetPath(input) {
        received = input;
        return path.join(root, `custom-${input.targetAgentSessionId}.jsonl`);
      },
    });

    expect(received).toMatchObject({
      sourcePath,
      targetAgentSessionId: result.agentSessionId,
    });
    expect(received?.createdAt).toBeInstanceOf(Date);
    expect(result.nativePath).toBe(path.join(root, `custom-${result.agentSessionId}.jsonl`));
    expect(await readFile(result.nativePath, 'utf8')).toContain('"value":"source"');
    expect((await stat(result.nativePath)).mode & 0o777).toBe(0o600);
  });

  it('rejects a whole-source mutation during transformation and removes the target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, `${JSON.stringify({ type: 'message', value: 'before' })}\n`);

    await expect(forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: null,
      transformEntries(input) {
        writeFileSync(sourcePath, `${JSON.stringify({ type: 'message', value: 'after' })}\n`);
        return { entries: input.selectedEntries };
      },
      createTargetPath(input) {
        return path.join(root, `custom-${input.targetAgentSessionId}.jsonl`);
      },
    })).rejects.toBeInstanceOf(JsonlSourcePrefixChangedError);

    expect((await readdir(root)).filter((name) => name !== 'source.jsonl')).toEqual([]);
  });

  it('copies a whole source that grows during transformation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, `${JSON.stringify({ type: 'message', value: 'copied' })}\n`);

    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: null,
      transformEntries(input) {
        appendFileSync(sourcePath, `${JSON.stringify({ type: 'message', value: 'appended' })}\n`);
        return { entries: input.selectedEntries };
      },
      createTargetPath(input) {
        return path.join(root, `custom-${input.targetAgentSessionId}.jsonl`);
      },
    });

    const forked = await readFile(result.nativePath, 'utf8');
    expect(forked).toContain('"value":"copied"');
    expect(forked).not.toContain('"value":"appended"');
  });

  it('leaves a missing whole-session source unmaterialized without creating a target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'project', 'source.jsonl');

    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: null,
      allowMissingSource: true,
      allowUnmaterializedWholeSession: true,
      transformEntries(input) {
        expect(input.sourceEntries).toEqual([]);
        return { entries: input.selectedEntries };
      },
    });

    expect(result).toEqual({ kind: 'unmaterialized' });
    expect(await readdir(root)).toEqual([]);
    await expect(stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves an empty whole-session source unmaterialized without creating a target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, '');

    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: null,
      allowUnmaterializedWholeSession: true,
    });

    expect(result).toEqual({ kind: 'unmaterialized' });
    expect(await readdir(root)).toEqual(['source.jsonl']);
  });

  it('leaves a fully filtered whole-session source unmaterialized without creating a target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, `${JSON.stringify({ type: 'provider-state' })}\n`);

    const result = await forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: null,
      allowUnmaterializedWholeSession: true,
      transformEntries: () => ({ entries: [] }),
    });

    expect(result).toEqual({ kind: 'unmaterialized' });
    expect(await readdir(root)).toEqual(['source.jsonl']);
  });

  it('rejects the unmaterialized option for message-point forks', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-fork-jsonl-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    await writeFile(sourcePath, '');

    await expect(forkJsonlTranscript({
      sourcePath,
      sourceAgentSessionId: 'source',
      cutoffLine: 0,
      allowUnmaterializedWholeSession: true,
    })).rejects.toThrow('Only whole-session JSONL forks can remain unmaterialized');

    expect(await readdir(root)).toEqual(['source.jsonl']);
  });

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
