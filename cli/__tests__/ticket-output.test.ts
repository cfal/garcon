import { describe, expect, test } from 'bun:test';
import { ticketBodyOutput, ticketJsonOutput, ticketLineOutput, ticketRetryDiagnostic, ticketShellArgument } from '../ticket-output.js';
import { readTicketStdin } from '../ticket-stdin.js';
import { parseCliArgs } from '../args.js';

describe('ticket terminal output', () => {
  test('escapes terminal controls and bidi in single-line, multiline and lossless JSON output', () => {
    const text = 'before\x1b]8;;https://example.invalid\x07after\x9b\x7f\u202e\u2066\u061c\n\t';
    for (const output of [ticketLineOutput(text), ticketJsonOutput({ text })]) {
      expect(output).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u202e\u2066]/u);
      expect(output).toContain('\\u001b');
    }
    expect(ticketBodyOutput(text)).toEndWith('\n\t');
    expect(JSON.parse(ticketJsonOutput({ text }))).toEqual({ text });
    expect(ticketLineOutput('literal \\u0009')).toBe('literal \\u0009');
  });

  test('prints only request identity and project with safely round-trippable shell arguments', async () => {
    const project = "Release 'quoted' \\ $value $(false) `false` \u202e";
    const diagnostic = ticketRetryDiagnostic({ requestId: '11111111-1111-4111-8111-111111111111',
      expectedStoreId: '22222222-2222-4222-8222-222222222222',
      payload: { action: 'create', input: { title: 'PRIVATE TITLE', description: 'PRIVATE BODY', project } } }, 'explicit');
    expect(diagnostic).toContain('Project (explicit)');
    expect(diagnostic).not.toContain('PRIVATE');
    expect(diagnostic).not.toContain('\u202e');
    const process = Bun.spawn(['bash', '-c', `printf '%s' ${ticketShellArgument(project)}`], { stdout: 'pipe', stderr: 'pipe' });
    expect(await new Response(process.stdout).text()).toBe(project);
    expect(await process.exited).toBe(0);
  });

  test.each([undefined, '/private/runtime.json'])('ticket retry additions do not repeat explicit connection flags: runtime=%s', async (runtimeFile) => {
    const env = runtimeFile ? { GARCON_CLI_RUNTIME: runtimeFile } : {};
    const original = ['--workspace', 'work', ...(runtimeFile ? [] : ['--config-dir', '/config']),
      '--server', 'http://127.0.0.1:8080', 'ticket', 'claim', 'G-1', '--expected-revision', '1'];
    const diagnostic = ticketRetryDiagnostic({ requestId: '11111111-1111-4111-8111-111111111111',
      expectedStoreId: '22222222-2222-4222-8222-222222222222',
      payload: { action: 'claim', ticketId: 'G-1', expectedRevision: 1 } }, undefined, runtimeFile);
    const flags = diagnostic.split('with: ')[1]!;
    const child = Bun.spawn(['bash', '-c', `printf '%s\\0' ${flags}`], { stdout: 'pipe', stderr: 'pipe' });
    const appended = (await new Response(child.stdout).text()).split('\0').slice(0, -1);
    expect(await child.exited).toBe(0);
    expect(parseCliArgs([...original, ...appended], env)).toMatchObject({
      kind: 'ticket', workspace: 'work', serverUrl: 'http://127.0.0.1:8080',
      retry: { requestId: '11111111-1111-4111-8111-111111111111', expectedStoreId: '22222222-2222-4222-8222-222222222222' },
      ...(runtimeFile ? { runtimeFile, expectedWorkspace: 'work' } : { configDir: '/config' }),
    });
    expect(diagnostic).not.toContain('--config-dir');
    expect(diagnostic).not.toContain('--workspace');
    expect(diagnostic).not.toContain('--server');
  });
});

describe('bounded ticket stdin', () => {
  const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } });
  test('decodes split UTF-8 and rejects malformed or oversized input', async () => {
    const bytes = new TextEncoder().encode('Synthetic é');
    expect(await readTicketStdin(stream([bytes.slice(0, -1), bytes.slice(-1)]))).toBe('Synthetic é');
    await expect(readTicketStdin(stream([new Uint8Array([0xff])]))).rejects.toMatchObject({ exitCode: 2 });
    await expect(readTicketStdin(stream([new Uint8Array([0xc3])]))).rejects.toMatchObject({ exitCode: 2 });
    await expect(readTicketStdin(stream([new Uint8Array(49153)]))).rejects.toMatchObject({ exitCode: 2 });
  });
  test('cancels a blocked input read without waiting for more bytes', async () => {
    const controller = new AbortController();
    let canceled = false;
    const pending = readTicketStdin(new ReadableStream({ cancel() { canceled = true; } }), controller.signal);
    controller.abort(new Error('Synthetic interruption'));
    await expect(pending).rejects.toThrow('Synthetic interruption');
    expect(canceled).toBe(true);
  });
});
