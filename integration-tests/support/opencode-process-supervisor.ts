// Test-only supervisor between Garcon and the pinned OpenCode binary. The fixture PATH shim
// executes this module; it verifies the pinned binary hermetically, records exact wrapper and
// provider PIDs, stops the provider child when a deliberately crashed Garcon parent disappears,
// and optionally reverse-proxies the real server so transport tests can hold the connected
// frame or reset the real /global/event socket. It records and signals only PIDs it created.

import { createServer, request as httpRequest, type Server } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PINNED_OPENCODE_VERSION = '1.18.4';

export interface OpenCodeProcessState {
  wrapperPid: number;
  providerPid: number;
  parentPid: number;
  mode: 'direct' | 'proxy';
  status: 'running' | 'stopping' | 'stopped';
  reason?: 'signal' | 'parent-exited' | 'provider-exited';
  version?: string;
}

export interface SupervisedChild {
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
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
  onChild?: (child: SupervisedChild) => void;
}): Promise<string> {
  const expected = input.expectedVersion ?? PINNED_OPENCODE_VERSION;
  const child = Bun.spawn([input.binary, '--version'], {
    env: input.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  input.onChild?.(child);
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  const version = stdout.trim();
  if (exitCode !== 0 || version !== expected) {
    throw new Error(
      `Pinned OpenCode binary reported "${version}" (exit ${exitCode}), expected "${expected}".`
      + (stderr.trim() ? ` stderr: ${stderr.trim()}` : ''),
    );
  }
  return version;
}

function sanitizedProviderEnv(source: NodeJS.ProcessEnv): Record<string, string> {
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

export async function runOpenCodeProcessSupervisor(argv: string[]): Promise<number> {
  const binary = process.env.GARCON_TEST_OPENCODE_REAL_BINARY;
  const processStateDir = process.env.GARCON_TEST_OPENCODE_PROCESS_STATE;
  const proxyDir = process.env.GARCON_TEST_OPENCODE_PROXY_DIR || null;
  if (!binary || !processStateDir) {
    process.stderr.write(
      'GARCON_TEST_OPENCODE_REAL_BINARY and GARCON_TEST_OPENCODE_PROCESS_STATE are required.\n',
    );
    return 2;
  }
  const mode: OpenCodeProcessState['mode'] = proxyDir ? 'proxy' : 'direct';
  const childEnv = sanitizedProviderEnv(process.env);
  await mkdir(processStateDir, { recursive: true });
  if (proxyDir) await mkdir(proxyDir, { recursive: true });

  const statePath = join(processStateDir, `wrapper-${process.pid}.json`);
  const state: OpenCodeProcessState = {
    wrapperPid: process.pid,
    providerPid: 0,
    parentPid: process.ppid,
    mode,
    status: 'running',
  };
  const writeState = async () => writeJsonAtomic(statePath, state);
  await writeState();

  // Signals can arrive while the version check or backend startup is still in flight, so the
  // in-flight child is tracked from the beginning and shutdown waits for startup to settle.
  let stopping = false;
  let starting = true;
  let exitCode = 0;
  let versionChild: SupervisedChild | null = null;
  let provider: Bun.Subprocess | null = null;
  let frontend: Server | null = null;
  const shutdown = async (reason: NonNullable<OpenCodeProcessState['reason']>) => {
    if (stopping) return;
    stopping = true;
    clearInterval(parentWatcher);
    while (starting) {
      await Bun.sleep(10);
    }
    state.status = 'stopping';
    state.reason = reason;
    await writeState().catch(() => undefined);
    if (versionChild) await stopChildWithEscalation(versionChild).catch(() => 1);
    if (provider) exitCode = await stopChildWithEscalation(provider);
    frontend?.close();
    state.status = 'stopped';
    await writeState().catch(() => undefined);
  };

  const parentPid = process.ppid;
  const parentWatcher = setInterval(() => {
    let alive = process.ppid === parentPid;
    if (alive) {
      try {
        process.kill(parentPid, 0);
      } catch {
        alive = false;
      }
    }
    if (!alive) void shutdown('parent-exited');
  }, PARENT_WATCH_MS);
  parentWatcher.unref?.();

  process.on('SIGTERM', () => void shutdown('signal'));
  process.on('SIGINT', () => void shutdown('signal'));

  try {
    const version = await verifyPinnedBinaryVersion({
      binary,
      env: childEnv,
      onChild: (child) => {
        versionChild = child;
      },
    });
    versionChild = null;
    state.version = version;
    await writeState();

    if (mode === 'direct') {
      provider = Bun.spawn([binary, ...argv], {
        env: childEnv,
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      });
    } else {
      const serve = parseServeArguments(argv);
      const backendPort = await freePort();
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
      provider = backend;
      const backendUrl = await waitForBackendReady(backend, backendPort);
      frontend = startTransportProxy({
        backendUrl,
        listen: serve,
        proxyDir: proxyDir!,
      });
      await new Promise<void>((resolve, reject) => {
        frontend!.once('error', reject);
        frontend!.listen(serve.port, serve.hostname, () => resolve());
      });
      // Garcon parses the readiness line it would have seen from the real server.
      process.stdout.write(
        `opencode server listening on http://${serve.hostname}:${serve.port}\n`,
      );
    }
    state.providerPid = provider.pid ?? 0;
    await writeState();
  } finally {
    starting = false;
  }

  void provider!.exited.then(() => {
    if (!stopping) void shutdown('provider-exited');
  });

  while (!stopping) {
    await Bun.sleep(50);
  }
  return exitCode;
}

function waitForBackendReady(
  backend: Bun.Subprocess<'ignore', 'pipe', 'inherit'>,
  port: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;
    const succeed = (url: string) => {
      if (settled) return;
      settled = true;
      resolve(url);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    void backend.exited.then((code) => {
      fail(new Error(`Pinned OpenCode backend exited with code ${code} before readiness.\n${output}`));
    });
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of backend.stdout) {
        const text = decoder.decode(chunk, { stream: true });
        output += text;
        for (const line of text.split('\n')) {
          // The backend readiness line is consumed here; the supervisor prints the proxy URL.
          const match = /^opencode server listening on\s+(https?:\/\/[^\s]+)/.exec(line.trim());
          if (match) {
            succeed(match[1]);
            continue;
          }
          if (line.trim()) process.stdout.write(`${line}\n`);
        }
      }
    })().catch(fail);
    setTimeout(() => {
      fail(new Error(`Pinned OpenCode backend never listened on port ${port}.\n${output}`));
    }, 15_000).unref();
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
