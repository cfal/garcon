import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { AgentRuntimeEvent, AgentRuntimeOperation } from '../../execution/runtime-events.js';

class DelayedExitProcess implements Bun.Subprocess<'pipe', 'pipe', 'pipe'> {
  readonly stdin = Bun.file('/dev/null').writer();
  #stdout!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  #stderr!: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
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
  push(message: unknown) { this.#stdout.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`)); }
  exit() { this.exitCode = 143; this.#exit.resolve(143); }
  async [Symbol.asyncDispose]() {
    this.exit();
    this.#stdout.close();
    this.#stderr.close();
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
      const stopping = action === 'abort' ? runtime.abort(request.agentSessionId)
        : (runtime.releaseSession(request.chatId, request.agentSessionId), Promise.resolve(true));
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
  });
}
