import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { AgentRuntimeEvent, AgentRuntimeOperation } from '../../execution/runtime-events.js';

export class DelayedExitProcess implements Bun.Subprocess<'pipe', 'pipe', 'pipe'> {
  readonly stdin = Bun.file('/dev/null').writer();
  #stdout!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  #stderr!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  #outputClosed = false;
  readonly stdout = new ReadableStream<Uint8Array<ArrayBuffer>>({ start: controller => { this.#stdout = controller; } });
  readonly stderr = new ReadableStream<Uint8Array<ArrayBuffer>>({ start: controller => { this.#stderr = controller; } });
  readonly readable = this.stdout;
  readonly terminal = undefined;
  readonly stdio: [null, null, null] = [null, null, null];
  readonly pid = 0;
  readonly #exit = Promise.withResolvers<number>();
  readonly exited = this.#exit.promise;
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly signals: (number | NodeJS.Signals)[] = [];
  get killed() { return this.exitCode !== null; }
  kill(signal: number | NodeJS.Signals = 'SIGTERM') { this.signals.push(signal); }
  ref() {}
  unref() {}
  send(_message: unknown) {}
  disconnect() {}
  resourceUsage() { return undefined; }
  pushRaw(text: string) { this.#stdout.enqueue(new TextEncoder().encode(text)); }
  pushStderr(text: string) { this.#stderr.enqueue(new TextEncoder().encode(text)); }
  push(message: unknown) { this.pushRaw(`${JSON.stringify(message)}\n`); }
  exit(code = 143) { this.exitCode = code; this.#exit.resolve(code); }
  closeOutput() {
    if (this.#outputClosed) return;
    this.#outputClosed = true;
    this.#stdout.close();
    this.#stderr.close();
  }
  async [Symbol.asyncDispose]() {
    this.exit();
    this.closeOutput();
    await this.stdin.end();
  }
}

interface TurnRequest {
  chatId: string;
  agentSessionId: string;
  command: string;
  projectPath: string;
  model: string;
  permissionMode: 'default';
  thinkingMode: 'none';
  operation: AgentRuntimeOperation;
  executionAdmission?: { signal: AbortSignal; markStarted(): Promise<void> };
}

interface TurnRuntime {
  runTurn(request: TurnRequest): Promise<void>;
  abort(id: string): Promise<boolean>;
  isRunning(id: string): boolean;
  releaseSession(chatId: string, id: string): void;
}

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export function processExitConformance(create: () => TurnRuntime): void {
  describe('direct-child termination admission', () => {
    const processes: DelayedExitProcess[] = [];
    let spawn: ReturnType<typeof spyOn<typeof Bun, 'spawn'>>;
    afterEach(async () => {
      spawn?.mockRestore();
      for (const process of processes.splice(0)) await process[Symbol.asyncDispose]();
      await turn();
    });

    function setup() {
      const first = new DelayedExitProcess();
      const second = new DelayedExitProcess();
      processes.push(first, second);
      spawn = spyOn(Bun, 'spawn').mockReturnValueOnce(first).mockReturnValueOnce(second);
      const events: AgentRuntimeEvent[] = [];
      const request: TurnRequest = { chatId: 'synthetic-chat', agentSessionId: 'synthetic-session',
        command: 'synthetic prompt', projectPath: '/workspace', model: '', permissionMode: 'default', thinkingMode: 'none',
        operation: { runId: 'synthetic-run', publish: event => { events.push(event); } } };
      return { runtime: create(), first, second, request, events };
    }

    test.each(['abort', 'release'] as const)('%s fences another turn until exit, independent of stdout EOF', async action => {
      const { runtime, first, second, request, events } = setup();
      const running = runtime.runTurn(request);
      await turn();
      expect(spawn).toHaveBeenCalledTimes(1);
      let stopping: Promise<boolean>;
      if (action === 'abort') {
        stopping = runtime.abort(request.agentSessionId);
      } else {
        runtime.releaseSession(request.chatId, request.agentSessionId);
        stopping = Promise.resolve(true);
      }
      const next = runtime.runTurn(request);
      await turn();
      expect(spawn).toHaveBeenCalledTimes(1);
      first.push({ type: 'result', is_error: false });
      await turn();
      expect(events.filter(event => event.type === 'run-ended')).toEqual([]);
      first.exit();
      await stopping;
      await running;
      await turn();
      expect(spawn).toHaveBeenCalledTimes(2);
      const count = events.length;
      first.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'late output' }] } });
      await turn();
      expect(events).toHaveLength(count);
      const stopped = runtime.abort(request.agentSessionId);
      second.exit();
      await stopped;
      await next;
    });

    test('escalates, retains unconfirmed admission, and recovers on late exit', async () => {
      const { runtime, first, second, request } = setup();
      const running = runtime.runTurn(request);
      await turn();
      expect(await runtime.abort(request.agentSessionId)).toBe(false);
      expect(first.signals).toEqual(['SIGTERM', 'SIGKILL']);
      expect(runtime.isRunning(request.agentSessionId)).toBe(true);
      await expect(runtime.runTurn(request)).rejects.toThrow('has not exited');
      expect(await runtime.abort(request.agentSessionId)).toBe(false);
      expect(first.signals).toHaveLength(2);
      first.exit();
      await running;
      const next = runtime.runTurn(request);
      await turn();
      expect(spawn).toHaveBeenCalledTimes(2);
      const stopped = runtime.abort(request.agentSessionId);
      second.exit();
      await stopped;
      await next;
    });

    test('cancels a resume waiting for termination without spawning', async () => {
      const { runtime, first, request } = setup();
      const running = runtime.runTurn(request);
      await turn();
      const stopping = runtime.abort(request.agentSessionId);
      const controller = new AbortController();
      const next = runtime.runTurn({ ...request, executionAdmission: { signal: controller.signal, async markStarted() {} } });
      controller.abort(new Error('cancelled admission'));
      await expect(next).rejects.toThrow('cancelled admission');
      expect(spawn).toHaveBeenCalledTimes(1);
      first.exit();
      await stopping;
      await running;
    });

    test('claims one session when two resumes finish preparation together', async () => {
      const { runtime, first, request } = setup();
      const running = runtime.runTurn(request);
      const second = expect(runtime.runTurn(request)).rejects.toThrow('already running');
      await second;
      expect(spawn).toHaveBeenCalledTimes(1);
      const stopping = runtime.abort(request.agentSessionId);
      first.exit();
      await stopping;
      await running;
    });

    test('a rejected stdin write fails launch and fences the child until exit', async () => {
      const { runtime, first, second, request } = setup();
      const write = spyOn(first.stdin, 'write').mockImplementation(() => Promise.reject(new Error('synthetic stdin failure')));
      try {
        await expect(runtime.runTurn(request)).rejects.toThrow('synthetic stdin failure');
        expect(first.signals).toEqual(['SIGTERM']);
        const next = runtime.runTurn(request);
        await turn();
        expect(spawn).toHaveBeenCalledTimes(1);
        first.exit();
        await turn();
        expect(spawn).toHaveBeenCalledTimes(2);
        const stopping = runtime.abort(request.agentSessionId);
        second.exit();
        await stopping;
        await next;
      } finally { write.mockRestore(); }
    });

    test('an exited child retains its exit diagnostic when the launch write rejects', async () => {
      const { runtime, first, request, events } = setup();
      const failure = new Error('EPIPE: broken pipe, write');
      const write = spyOn(first.stdin, 'write').mockImplementation(() => {
        first.exit(3);
        return Promise.reject(failure);
      });
      try {
        await expect(runtime.runTurn(request)).rejects.toMatchObject({
          message: expect.stringContaining('code 3'), cause: failure,
        });
        for (const event of events) {
          if (event.type === 'run-ended') expect(event.error?.message).toContain('code 3');
        }
      } finally { write.mockRestore(); }
    });

    test('a real child exiting before reading a large prompt reports its exit code', async () => {
      const child = Bun.spawn([process.execPath, '-e', 'process.exit(3)'], {
        env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
      });
      const { runtime, request, events } = setup();
      spawn.mockReset().mockReturnValue(child);
      try {
        await expect(runtime.runTurn({ ...request, command: 'x'.repeat(4 * 1024 * 1024) }))
          .rejects.toThrow('code 3');
        for (const event of events) {
          if (event.type === 'run-ended') expect(event.error?.message).toContain('code 3');
        }
      } finally {
        child.kill('SIGKILL');
        await child.exited;
      }
    });

    test('release during admission prevents a late spawn', async () => {
      const { runtime, request } = setup();
      const admitted = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const running = runtime.runTurn({ ...request, executionAdmission: {
        signal: new AbortController().signal,
        async markStarted() { entered.resolve(); await admitted.promise; },
      } });
      await entered.promise;
      runtime.releaseSession(request.chatId, request.agentSessionId);
      admitted.resolve();
      await expect(running).rejects.toThrow('retired before launch');
      expect(spawn).not.toHaveBeenCalled();
    });

    test('admission cancellation terminates a child with a pending launch write', async () => {
      const { runtime, first, request, events } = setup();
      const entered = Promise.withResolvers<void>();
      const written = Promise.withResolvers<number>();
      const write = spyOn(first.stdin, 'write').mockImplementation(() => { entered.resolve(); return written.promise; });
      const admission = new AbortController();
      const running = runtime.runTurn({ ...request, executionAdmission: {
        signal: admission.signal, async markStarted() {},
      } });
      try {
        await entered.promise;
        admission.abort(new Error('cancelled pending write'));
        expect(first.signals).toEqual(['SIGTERM']);
        first.exit();
        written.resolve(1);
        await expect(running).rejects.toThrow('cancelled pending write');
        expect(events.some(event => event.type === 'steerable')).toBe(false);
        expect(runtime.isRunning(request.agentSessionId)).toBe(false);
      } finally { write.mockRestore(); }
    });
  });
}
