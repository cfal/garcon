// Test-only supervisor between Garcon and the pinned OpenCode binary. The fixture PATH shim
// executes this module; it verifies the pinned binary hermetically, records exact wrapper and
// provider PIDs, stops the provider child when a deliberately crashed Garcon parent disappears,
// and optionally reverse-proxies the real server so transport tests can hold the connected
// frame or reset the real /global/event socket. It records and signals only PIDs it created.

import { createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PINNED_OPENCODE_VERSION = '1.18.4';

export interface OpenCodeProcessState {
  generationId: string;
  wrapperPid: number;
  wrapperStartTimeTicks: string;
  providerPid: number;
  providerStartTimeTicks: string | null;
  parentPid: number;
  parentStartTimeTicks: string;
  mode: 'direct' | 'proxy';
  status: 'running' | 'stopping' | 'stopped';
  reason?: 'signal' | 'parent-exited' | 'provider-exited' | 'startup-failed';
  version?: string;
}

export interface OpenCodeBinaryVerification {
  binary: string;
  version: string;
}

export interface SupervisedChild {
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface BackendReadinessProcess {
  readonly exited: Promise<number>;
  readonly stdout: ReadableStream<Uint8Array>;
}

interface TransportDirective {
  seq: number;
  action: 'hold' | 'release' | 'reset';
  connectionId?: number;
}

interface TransportDirectives {
  directives: TransportDirective[];
}

interface GlobalConnectionObservation {
  id: number;
  path: string;
  held: boolean;
  released: boolean;
  reset: boolean;
  closed: boolean;
}

// Live per-connection proxy state; directives act on it immediately instead of waiting for
// the next upstream chunk.
interface GlobalConnectionRuntime {
  observation: GlobalConnectionObservation;
  holdsConnectedFrame: boolean;
  buffered: Buffer[];
  release(): void;
  reset(): void;
}

interface TransportObservations {
  appliedSeq: number;
  requests: Array<{ method: string; path: string }>;
  connections: GlobalConnectionObservation[];
}

const MAX_OBSERVED_REQUESTS = 500;
const DIRECTIVE_POLL_MS = 15;
const PARENT_WATCH_MS = 25;
const PROVIDER_STOP_GRACE_MS = 250;
// Shutdown kills must land well inside Garcon's 500ms wrapper SIGKILL budget.
const SHUTDOWN_KILL_GRACE_MS = 100;

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
}

// Returns null when the file does not exist; malformed JSON throws so a torn write is loud.
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// SIGTERM first, then SIGKILL after the grace window; only ever the supplied child.
export async function stopChildWithEscalation(
  child: SupervisedChild,
  graceMs: number = PROVIDER_STOP_GRACE_MS,
): Promise<number> {
  const exit = child.exited;
  child.kill('SIGTERM');
  const graceful = await Promise.race([
    exit.then(() => true),
    Bun.sleep(graceMs).then(() => false),
  ]);
  if (!graceful) child.kill('SIGKILL');
  return await exit;
}

// Runs the pinned binary's --version under the exact sanitized environment the provider child
// will receive, so version validation never touches the test runner's ambient home.
export async function verifyPinnedBinaryVersion(input: {
  binary: string;
  env: Record<string, string>;
  expectedVersion?: string;
  timeoutMs?: number;
}): Promise<string> {
  const expected = input.expectedVersion ?? PINNED_OPENCODE_VERSION;
  const child = Bun.spawn([input.binary, '--version'], {
    env: input.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const completion = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      void stopChildWithEscalation(child).finally(() => {
        reject(new Error(`Pinned OpenCode version check timed out after ${input.timeoutMs ?? 15_000}ms.`));
      });
    }, input.timeoutMs ?? 15_000);
    timeout.unref?.();
  });
  const [stdout, stderr, exitCode] = await Promise.race([completion, timedOut]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  const version = stdout.trim();
  if (exitCode !== 0 || version !== expected) {
    throw new Error(
      `Pinned OpenCode binary reported "${version}" (exit ${exitCode}), expected "${expected}".`
      + (stderr.trim() ? ` stderr: ${stderr.trim()}` : ''),
    );
  }
  return version;
}

export function buildOpenCodeProviderEnvironment(
  source: NodeJS.ProcessEnv | Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (name.startsWith('GARCON_TEST_OPENCODE_')) continue;
    env[name] = value;
  }
  // Empty auth is injected here, never through the Garcon environment audit surface.
  env.OPENCODE_AUTH_CONTENT = '{}';
  return env;
}

// Linux start-time ticks distinguish a live test process from a later process that reused its PID.
export function linuxProcessStartTimeTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(') ');
    if (commandEnd < 0) return null;
    // The suffix begins at field 3 (state); process start time is field 22.
    return stat.slice(commandEnd + 2).trim().split(/\s+/)[19] ?? null;
  } catch {
    return null;
  }
}

export function processIdentityAlive(pid: number, startTimeTicks: string | null): boolean {
  return startTimeTicks !== null && linuxProcessStartTimeTicks(pid) === startTimeTicks;
}

function parseServeArguments(argv: string[]): { hostname: string; port: number } {
  let hostname = '127.0.0.1';
  let port = 0;
  for (const argument of argv) {
    if (argument.startsWith('--hostname=')) hostname = argument.slice('--hostname='.length);
    if (argument.startsWith('--port=')) port = Number(argument.slice('--port='.length));
  }
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Supervisor could not parse the requested port from: ${argv.join(' ')}`);
  }
  return { hostname, port };
}

async function freePort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('Failed to reserve an OpenCode backend port.');
  return port;
}

async function waitForProviderStartGate(
  path: string | undefined,
  isStopping: () => boolean,
): Promise<void> {
  if (!path) return;
  while (!isStopping()) {
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await Bun.sleep(10);
  }
}

export async function runOpenCodeProcessSupervisor(argv: string[]): Promise<number> {
  // Capturing the original parent before any await prevents adoption from changing the owner
  // that this wrapper is responsible for watching.
  const parentPid = process.ppid;
  const parentStartTimeTicks = linuxProcessStartTimeTicks(parentPid);
  const binary = process.env.GARCON_TEST_OPENCODE_REAL_BINARY;
  const processStateDir = process.env.GARCON_TEST_OPENCODE_PROCESS_STATE;
  const verificationPath = process.env.GARCON_TEST_OPENCODE_VERIFICATION;
  const proxyDir = process.env.GARCON_TEST_OPENCODE_PROXY_DIR || null;
  if (!binary || !processStateDir || !verificationPath || !parentStartTimeTicks) {
    process.stderr.write(
      'OpenCode supervisor requires its binary, verification, process state, and original parent identity.\n',
    );
    return 2;
  }
  const mode: OpenCodeProcessState['mode'] = proxyDir ? 'proxy' : 'direct';
  const childEnv = buildOpenCodeProviderEnvironment(process.env);
  const wrapperStartTimeTicks = linuxProcessStartTimeTicks(process.pid);
  if (!wrapperStartTimeTicks) {
    process.stderr.write('OpenCode supervisor could not establish its Linux process identity.\n');
    return 2;
  }

  const statePath = join(processStateDir, `wrapper-${process.pid}.json`);
  const state: OpenCodeProcessState = {
    generationId: crypto.randomUUID(),
    wrapperPid: process.pid,
    wrapperStartTimeTicks,
    providerPid: 0,
    providerStartTimeTicks: null,
    parentPid,
    parentStartTimeTicks,
    mode,
    status: 'running',
  };
  let stateWriteTail = Promise.resolve();
  const writeState = (): Promise<void> => {
    const snapshot = { ...state };
    const write = stateWriteTail.then(async () => {
      await mkdir(processStateDir, { recursive: true });
      await writeJsonAtomic(statePath, snapshot);
    });
    stateWriteTail = write.catch(() => undefined);
    return write;
  };

  // Garcon SIGKILLs this wrapper 500ms after SIGTERM, so shutdown must kill the provider
  // well inside that budget. Every await before spawn is followed by a stopping check, and
  // registration is synchronous with spawn, so shutdown always owns every created child.
  let stopping = false;
  let exitCode = 0;
  let provider: Bun.Subprocess | null = null;
  let frontend: Server | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let parentWatcher: ReturnType<typeof setInterval> | null = null;
  let announceShutdown!: () => void;
  const shutdownStarted = new Promise<void>((resolve) => {
    announceShutdown = resolve;
  });
  const shutdown = (reason: NonNullable<OpenCodeProcessState['reason']>): void => {
    if (shutdownPromise) return;
    stopping = true;
    announceShutdown();
    if (parentWatcher) clearInterval(parentWatcher);
    state.status = 'stopping';
    state.reason = reason;
    shutdownPromise = (async () => {
      await writeState().catch(() => undefined);
      if (provider) {
        exitCode = await stopChildWithEscalation(provider, SHUTDOWN_KILL_GRACE_MS)
          .catch(() => 1);
      }
      frontend?.closeAllConnections?.();
      frontend?.close();
      state.status = 'stopped';
      await writeState().catch(() => undefined);
    })();
  };

  parentWatcher = setInterval(() => {
    if (
      process.ppid !== parentPid
      || !processIdentityAlive(parentPid, parentStartTimeTicks)
    ) {
      shutdown('parent-exited');
    }
  }, PARENT_WATCH_MS);
  parentWatcher.unref?.();

  process.on('SIGTERM', () => shutdown('signal'));
  process.on('SIGINT', () => shutdown('signal'));

  try {
    await mkdir(processStateDir, { recursive: true });
    if (proxyDir) await mkdir(proxyDir, { recursive: true });
    if (stopping) {
      await shutdownPromise;
      return exitCode;
    }

    const verification = await readJsonFile<OpenCodeBinaryVerification>(verificationPath);
    if (
      verification?.binary !== binary
      || verification.version !== PINNED_OPENCODE_VERSION
    ) {
      throw new Error('Pinned OpenCode binary was not verified during fixture preparation.');
    }
    state.version = verification.version;
    await writeState();
    if (
      stopping
      || process.ppid !== parentPid
      || !processIdentityAlive(parentPid, parentStartTimeTicks)
    ) {
      shutdown('parent-exited');
      await shutdownPromise;
      return exitCode;
    }

    const registerProvider = (child: Bun.Subprocess): void => {
      provider = child;
      state.providerPid = child.pid ?? 0;
      state.providerStartTimeTicks = linuxProcessStartTimeTicks(state.providerPid);
      if (!state.providerPid || !state.providerStartTimeTicks) {
        throw new Error('OpenCode supervisor could not establish the provider process identity.');
      }
      void child.exited.then(() => {
        if (!stopping) shutdown('provider-exited');
      });
    };

    if (mode === 'direct') {
      await waitForProviderStartGate(
        process.env.GARCON_TEST_OPENCODE_START_GATE,
        () => stopping,
      );
      if (stopping) {
        await shutdownPromise;
        return exitCode;
      }
      registerProvider(Bun.spawn([binary, ...argv], {
        env: childEnv,
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      }));
      await writeState();
    } else {
      const serve = parseServeArguments(argv);
      const backendPort = await freePort();
      await waitForProviderStartGate(
        process.env.GARCON_TEST_OPENCODE_START_GATE,
        () => stopping,
      );
      if (stopping) {
        await shutdownPromise;
        return exitCode;
      }
      const backend = Bun.spawn([
        binary,
        'serve',
        `--hostname=${serve.hostname}`,
        `--port=${backendPort}`,
      ], {
        env: childEnv,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'inherit',
      });
      registerProvider(backend);
      await writeState();
      if (stopping) {
        await shutdownPromise;
        return exitCode;
      }
      const backendUrl = await waitForBackendReady(backend, backendPort);
      if (stopping) {
        await shutdownPromise;
        return exitCode;
      }
      frontend = startTransportProxy({
        backendUrl,
        listen: serve,
        proxyDir: proxyDir!,
      });
      const listening = new Promise<void>((resolve, reject) => {
        frontend!.once('error', reject);
        frontend!.listen(serve.port, serve.hostname, () => resolve());
      });
      await Promise.race([listening, shutdownStarted]);
      if (stopping) {
        await shutdownPromise;
        return exitCode;
      }
      // Garcon parses the readiness line it would have seen from the real server.
      process.stdout.write(
        `opencode server listening on http://${serve.hostname}:${serve.port}\n`,
      );
    }
  } catch (error) {
    if (!stopping) {
      shutdown('startup-failed');
      await shutdownPromise;
      throw error;
    }
  }

  while (!shutdownPromise) {
    await Bun.sleep(25);
  }
  await shutdownPromise;
  return exitCode;
}

export function waitForBackendReady(
  backend: BackendReadinessProcess,
  port: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = '';
    let pendingLine = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const succeed = (url: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(url);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    };
    const consume = (text: string, flush: boolean): void => {
      pendingLine += text;
      const lines = pendingLine.split('\n');
      pendingLine = flush ? '' : lines.pop() ?? '';
      for (const line of lines) {
        // The backend readiness line is consumed here; the supervisor prints the proxy URL.
        const match = /^opencode server listening on\s+(https?:\/\/[^\s]+)/.exec(line.trim());
        if (match) {
          succeed(match[1]);
        } else if (line.trim()) {
          process.stdout.write(`${line}\n`);
        }
      }
    };
    timeout = setTimeout(() => {
      fail(new Error(`Pinned OpenCode backend never listened on port ${port}.\n${output}`));
    }, 15_000);
    timeout.unref();
    void backend.exited.then((code) => {
      fail(new Error(`Pinned OpenCode backend exited with code ${code} before readiness.\n${output}`));
    });
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of backend.stdout) {
        const text = decoder.decode(chunk, { stream: true });
        output += text;
        consume(text, false);
      }
      const tail = decoder.decode();
      output += tail;
      consume(tail, true);
    })().catch(fail);
  });
}

function startTransportProxy(input: {
  backendUrl: string;
  listen: { hostname: string; port: number };
  proxyDir: string;
}): Server {
  const directivesPath = join(input.proxyDir, 'directives.json');
  const observationsPath = join(input.proxyDir, 'observations.json');
  const backend = new URL(input.backendUrl);
  const observations: TransportObservations = { appliedSeq: 0, requests: [], connections: [] };
  const runtimes = new Map<number, GlobalConnectionRuntime>();
  let nextConnectionId = 0;
  let lastAppliedSeq = 0;
  let holdArmed = false;
  let observationsDirty = false;
  let writingObservations = false;

  const markObservationsDirty = () => {
    observationsDirty = true;
  };
  const flushObservations = async () => {
    if (writingObservations || !observationsDirty) return;
    writingObservations = true;
    observationsDirty = false;
    try {
      await writeJsonAtomic(observationsPath, observations);
    } catch {
      // The proxy directory disappears during fixture teardown; observations are best effort.
    } finally {
      writingObservations = false;
      if (observationsDirty) await flushObservations();
    }
  };
  const observationPump = setInterval(() => void flushObservations(), 25);
  observationPump.unref?.();

  const applyDirectives = async () => {
    let parsed: TransportDirectives | null = null;
    try {
      parsed = await readJsonFile<TransportDirectives>(directivesPath);
    } catch {
      return;
    }
    if (!parsed || !Array.isArray(parsed.directives)) return;
    for (const directive of parsed.directives) {
      if (directive.seq <= lastAppliedSeq) continue;
      lastAppliedSeq = directive.seq;
      if (directive.action === 'hold') {
        holdArmed = true;
      } else {
        const runtime = runtimes.get(directive.connectionId ?? -1);
        if (runtime) {
          if (directive.action === 'release') runtime.release();
          if (directive.action === 'reset') runtime.reset();
        }
      }
      observations.appliedSeq = lastAppliedSeq;
      markObservationsDirty();
    }
  };
  const directivePump = setInterval(() => void applyDirectives(), DIRECTIVE_POLL_MS);
  directivePump.unref?.();

  const recordRequest = (method: string, path: string) => {
    observations.requests.push({ method, path });
    if (observations.requests.length > MAX_OBSERVED_REQUESTS) {
      observations.requests.splice(0, observations.requests.length - MAX_OBSERVED_REQUESTS);
    }
    markObservationsDirty();
  };

  return createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0];
    recordRequest(request.method ?? 'GET', path);
    const upstream = httpRequest({
      hostname: backend.hostname,
      port: backend.port,
      path: request.url ?? '/',
      method: request.method ?? 'GET',
      headers: { ...request.headers, host: backend.host },
    }, (backendResponse) => {
      response.writeHead(backendResponse.statusCode ?? 502, backendResponse.headers);
      if (path !== '/global/event') {
        backendResponse.pipe(response);
        return;
      }

      const connection: GlobalConnectionObservation = {
        id: ++nextConnectionId,
        path,
        held: false,
        released: false,
        reset: false,
        closed: false,
      };
      observations.connections.push(connection);
      const runtime: GlobalConnectionRuntime = {
        observation: connection,
        holdsConnectedFrame: holdArmed,
        buffered: [],
        release() {
          if (connection.released || connection.closed) return;
          connection.released = true;
          for (const held of runtime.buffered) response.write(held);
          runtime.buffered = [];
          markObservationsDirty();
        },
        reset() {
          if (connection.reset || connection.closed) return;
          connection.reset = true;
          connection.closed = true;
          // A genuine network error: destroying both sockets makes the generated SDK reader
          // see a reset, not a clean EOF.
          backendResponse.destroy(new Error('Intentional OpenCode SSE reset'));
          response.destroy(new Error('Intentional OpenCode SSE reset'));
          markObservationsDirty();
        },
      };
      runtimes.set(connection.id, runtime);
      holdArmed = false;
      markObservationsDirty();

      let observedText = '';
      backendResponse.on('data', (chunk: Buffer) => {
        if (connection.reset || connection.closed) return;
        if (runtime.holdsConnectedFrame && !connection.released) {
          runtime.buffered.push(chunk);
          observedText += chunk.toString('utf8');
          if (!connection.held && observedText.includes('server.connected')) {
            connection.held = true;
            markObservationsDirty();
          }
          return;
        }
        response.write(chunk);
      });
      backendResponse.on('end', () => {
        connection.closed = true;
        markObservationsDirty();
        response.end();
      });
      backendResponse.on('error', () => {
        connection.closed = true;
        markObservationsDirty();
        response.destroy();
      });
      response.on('close', () => {
        connection.closed = true;
        markObservationsDirty();
        backendResponse.destroy();
      });
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
}

if (import.meta.main) {
  runOpenCodeProcessSupervisor(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
