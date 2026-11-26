import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Deferred, withTimeout } from '../../../integration-tests/support/deferred.js';
import { fixtureAuthToken, prepareFixtureAuth } from '../../../integration-tests/support/fixture-auth.js';
import { frontDoorEnvironment, isolatedEnvironment, pumpLines } from '../../../integration-tests/support/garcon-process.js';

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

export async function startServer(repoRoot: string, build: ServerBuild, options: ServerOptions = {}): Promise<StartedServer> {
  const dirs = await createDirectories();
  // A fixed username keeps recorded responses that echo it comparable.
  const credentials = await prepareFixtureAuth(dirs.configDir, 'parity');
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
    // A fixed time zone and locale keep recordings comparable across machines.
    env: isolatedEnvironment(dirs.homeDir, {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      TZ: 'UTC',
      LANG: 'C.UTF-8',
      ...frontDoorEnvironment(),
      GARCON_RS_FALLBACK_LOG: fallbackLogPath,
      GARCON_WEB_BUILD_DIR: options.webBuildDir ?? join(repoRoot, WEB_BUILD_FIXTURE),
      ...options.environment,
    }),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let output = '';
  const ready = new Deferred<string>();
  const onLine = (line: string) => {
    const match = READY_PATTERN.exec(line);
    if (match) ready.resolve(match[1].replace(/\/$/, ''));
  };
  const onText = (text: string) => { output += text; };
  void pumpLines(child.stdout, 'stdout', onText, onLine);
  void pumpLines(child.stderr, 'stderr', onText, onLine);
  void child.exited.then((code) => ready.reject(new Error(`${build.label} exited with code ${code} before it was ready\n${output}`)));

  const stop = async () => {
    child.kill('SIGTERM');
    const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(10_000).then(() => false)]);
    if (!exited) child.kill('SIGKILL');
    await child.exited;
    await rm(dirs.root, { recursive: true, force: true });
  };

  try {
    const baseUrl = await withTimeout(ready.promise, STARTUP_TIMEOUT_MS,
      () => `${build.label} did not start within ${STARTUP_TIMEOUT_MS} ms\n${output}`);
    const startupMs = performance.now() - spawnedAt;
    const url = new URL(baseUrl);
    return {
      origin: url.origin,
      baseUrl,
      port: url.port,
      token: await fixtureAuthToken(baseUrl, credentials),
      credentials,
      dirs,
      fallbackLogPath,
      pid: child.pid,
      startupMs,
      logs: () => output,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
