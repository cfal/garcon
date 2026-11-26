import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const READY_PATTERN = /Started at (http:\/\/[^\s]+)/;
const STARTUP_TIMEOUT_MS = 60_000;
// A fixed web build keeps static-asset recordings independent of local builds.
const WEB_BUILD_FIXTURE = 'rust/parity/fixtures/web-build';

export interface ParityDirectories {
  root: string;
  configDir: string;
  workspaceDir: string;
  projectDir: string;
  homeDir: string;
}

export interface ParityCredentials {
  username: string;
  password: string;
}

export interface ServerBuild {
  label: string;
  command: string[];
}

export interface StartedServer {
  origin: string;
  baseUrl: string;
  port: string;
  token: string;
  credentials: ParityCredentials;
  dirs: ParityDirectories;
  fallbackLogPath: string;
  // The spawned process; behind the front door the original is its child.
  pid: number;
  // From spawn until the server announced its URL.
  startupMs: number;
  logs(): string;
  stop(): Promise<void>;
}

export interface ServerOptions {
  basePath?: string;
  files?: Record<string, string>;
  // Defaults to the fixture build; benchmarks serve a real production build.
  webBuildDir?: string;
  // Extra environment for this server, such as a unit kill switch.
  environment?: Record<string, string>;
}

// The original is the TypeScript controller, started exactly as `bun run
// start` does. Every build under test receives the same arguments.
export function originalBuild(): ServerBuild {
  return { label: 'original', command: [process.execPath, 'server/main.ts'] };
}

export function commandBuild(command: string): ServerBuild {
  return { label: command, command: command.split(/\s+/).filter(Boolean) };
}

async function createDirectories(): Promise<ParityDirectories> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'garcon-parity-')));
  const dirs = {
    root,
    configDir: join(root, 'config'),
    workspaceDir: join(root, 'workspace'),
    projectDir: join(root, 'project'),
    homeDir: join(root, 'home'),
  };
  await Promise.all([dirs.configDir, dirs.workspaceDir, dirs.projectDir, join(dirs.homeDir, 'tmp')]
    .map((dir) => mkdir(dir, { recursive: true })));
  return dirs;
}

// Seeds credentials the same way the integration fixture does, with a fixed
// username so recorded responses that echo it stay comparable.
async function seedAuthentication(configDir: string): Promise<ParityCredentials> {
  const credentials = { username: 'parity', password: randomBytes(24).toString('hex') };
  await writeFile(join(configDir, 'auth.json'), JSON.stringify({
    username: credentials.username,
    ownerKey: credentials.username,
    credentialRevision: 1,
    passwordHash: await Bun.password.hash(credentials.password, { algorithm: 'bcrypt', cost: 4 }),
    jwtSecret: randomBytes(32).toString('hex'),
  }), { mode: 0o600 });
  return credentials;
}

async function seedFiles(dirs: ParityDirectories, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const [root, ...rest] = relativePath.split('/');
    const base = root === 'project' ? dirs.projectDir
      : root === 'workspace' ? dirs.workspaceDir
        : root === 'config' ? dirs.configDir
          : null;
    if (!base || rest.length === 0) throw new Error(`Seed path must start with project/, workspace/, or config/: ${relativePath}`);
    const target = join(base, ...rest);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

async function login(baseUrl: string, credentials: ParityCredentials): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as { token?: unknown };
  if (!response.ok || typeof body.token !== 'string') {
    throw new Error(`Parity login failed with status ${response.status}`);
  }
  return body.token;
}

function frontDoorEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[0].startsWith('GARCON_RS_') && entry[1] !== undefined));
}

export async function startServer(repoRoot: string, build: ServerBuild, options: ServerOptions = {}): Promise<StartedServer> {
  const dirs = await createDirectories();
  const credentials = await seedAuthentication(dirs.configDir);
  await seedFiles(dirs, options.files ?? {});
  const fallbackLogPath = join(dirs.root, 'fallback.log');
  await writeFile(fallbackLogPath, '');

  const args = [
    '--port', '0',
    '--bind-address', '127.0.0.1',
    '--config-dir', dirs.configDir,
    '--workspace-dir', dirs.workspaceDir,
    '--project-base-dir', dirs.projectDir,
    ...(options.basePath ? ['--base-path', options.basePath] : []),
  ];
  const spawnedAt = performance.now();
  const child = Bun.spawn({
    cmd: [...build.command, ...args],
    cwd: repoRoot,
    env: {
      HOME: dirs.homeDir,
      TMPDIR: join(dirs.homeDir, 'tmp'),
      XDG_CONFIG_HOME: join(dirs.homeDir, '.config'),
      XDG_DATA_HOME: join(dirs.homeDir, '.local/share'),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NO_COLOR: '1',
      TZ: 'UTC',
      LANG: 'C.UTF-8',
      // Front-door settings such as unit kill switches pass through.
      ...frontDoorEnvironment(),
      GARCON_RS_FALLBACK_LOG: fallbackLogPath,
      GARCON_WEB_BUILD_DIR: options.webBuildDir ?? join(repoRoot, WEB_BUILD_FIXTURE),
      ...options.environment,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let output = '';
  const ready = Promise.withResolvers<string>();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk, { stream: true });
      const match = READY_PATTERN.exec(output);
      if (match) ready.resolve(match[1].replace(/\/$/, ''));
    }
  };
  void pump(child.stdout);
  void pump(child.stderr);
  void child.exited.then((code) => ready.reject(new Error(`${build.label} exited with code ${code} before it was ready\n${output}`)));
  const timer = setTimeout(() => ready.reject(new Error(`${build.label} did not start within ${STARTUP_TIMEOUT_MS} ms\n${output}`)), STARTUP_TIMEOUT_MS);

  const stop = async () => {
    child.kill('SIGTERM');
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!exited) child.kill('SIGKILL');
    await child.exited;
    await rm(dirs.root, { recursive: true, force: true });
  };

  try {
    const baseUrl = await ready.promise;
    const startupMs = performance.now() - spawnedAt;
    clearTimeout(timer);
    const url = new URL(baseUrl);
    return {
      origin: url.origin,
      baseUrl,
      port: url.port,
      token: await login(baseUrl, credentials),
      credentials,
      dirs,
      fallbackLogPath,
      pid: child.pid,
      startupMs,
      logs: () => output,
      stop,
    };
  } catch (error) {
    clearTimeout(timer);
    await stop();
    throw error;
  }
}
