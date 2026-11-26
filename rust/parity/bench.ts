#!/usr/bin/env bun
// Benchmarks the TypeScript original against the Rust front door, with its
// native units on and with every request sent to the original, and writes
// rust/BENCHMARKS.md. Requires `bun run build` and `bun run rust:build`.
// See rust/README.md.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { webSocketProtocolsForAuth } from '../../common/ws-auth.js';
import { commandBuild, originalBuild, startServer, type ServerBuild, type StartedServer } from './src/environment.js';

const repoRoot = resolve(import.meta.dir, '../..');
const benchBinary = join(repoRoot, 'rust/target/release/garcon-bench');
const frontDoorBinary = 'rust/target/release/garcon-server';
const webBuildDir = join(repoRoot, 'web/build');
const CLOCK_TICKS_PER_SECOND = 100;

interface Configuration {
  name: string;
  build: ServerBuild;
  environment: Record<string, string>;
}

interface Scenario {
  name: string;
  description: string;
  mode: 'http' | 'ws';
  path: string;
  args: (server: StartedServer) => string[];
  concurrency: number;
}

interface Measurement {
  requestsPerSecond: number;
  megabytesPerSecond: number;
  p50Micros: number;
  p99Micros: number;
  errors: number;
  cpuMicrosPerRequest: number;
  frontDoorCpuShare: number | null;
}

const configurations: Configuration[] = [
  { name: 'original', build: originalBuild(), environment: {} },
  { name: 'front door', build: commandBuild(frontDoorBinary), environment: {} },
  { name: 'front door, all fallback', build: commandBuild(frontDoorBinary), environment: { GARCON_RS_UNIT_STATIC_ASSETS: 'original' } },
];

function assets(): { large: string; largeBytes: number; small: string; smallBytes: number } {
  const files: Array<{ path: string; size: number }> = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push({ path, size: statSync(path).size });
    }
  };
  walk(join(webBuildDir, '_app/immutable'));
  const scripts = files.filter((file) => file.path.endsWith('.js')).sort((left, right) => right.size - left.size);
  const styles = files.filter((file) => file.path.endsWith('.css') && file.size >= 4096 && file.size <= 32768)
    .sort((left, right) => left.size - right.size);
  if (!scripts[0] || !styles[0]) throw new Error('web/build has no immutable assets; run bun run build');
  return {
    large: `/${relative(webBuildDir, scripts[0].path)}`,
    largeBytes: scripts[0].size,
    small: `/${relative(webBuildDir, styles[0].path)}`,
    smallBytes: styles[0].size,
  };
}

function scenarios(asset: ReturnType<typeof assets>): Scenario[] {
  const http = (name: string, description: string, path: string, headers: string[], concurrency: number, auth = false): Scenario => ({
    name, description, mode: 'http', concurrency, path,
    args: (server) => [...headers, ...(auth ? [`Authorization: Bearer ${server.token}`] : [])].flatMap((header) => ['--header', header]),
  });
  const ws = (name: string, concurrency: number): Scenario => ({
    name, description: 'ws-ping round trip on the browser socket (relayed)', mode: 'ws', concurrency, path: '/ws',
    args: (server) => webSocketProtocolsForAuth(server.token).flatMap((protocol) => ['--protocol', protocol]),
  });
  const large = `${Math.round(asset.largeBytes / 1024)} KiB`;
  const small = `${Math.round(asset.smallBytes / 1024)} KiB`;
  return [
    http('large asset, gzip, 1 client', `Largest JS chunk (${large}), Accept-Encoding: gzip`, asset.large, ['Accept-Encoding: gzip'], 1),
    http('large asset, gzip, 16 clients', `Largest JS chunk (${large}), Accept-Encoding: gzip`, asset.large, ['Accept-Encoding: gzip'], 16),
    http('large asset, identity, 16 clients', `Largest JS chunk (${large}), uncompressed`, asset.large, ['Accept-Encoding: identity'], 16),
    http('small asset, gzip, 1 client', `CSS asset (${small}), Accept-Encoding: gzip`, asset.small, ['Accept-Encoding: gzip'], 1),
    http('small asset, gzip, 16 clients', `CSS asset (${small}), Accept-Encoding: gzip`, asset.small, ['Accept-Encoding: gzip'], 16),
    http('auth status, 1 client', 'GET /api/v1/auth/status (proxied to the original)', '/api/v1/auth/status', [], 1),
    http('auth status, 16 clients', 'GET /api/v1/auth/status (proxied to the original)', '/api/v1/auth/status', [], 16),
    http('chat list, 16 clients', 'Authenticated GET /api/v1/chats (proxied)', '/api/v1/chats', ['Accept-Encoding: gzip'], 16, true),
    ws('WebSocket ping, 1 client', 1),
    ws('WebSocket ping, 16 clients', 16),
  ];
}

interface ProcessTable {
  // User and system CPU time in microseconds, by pid.
  cpu: Map<number, number>;
  children: Map<number, number[]>;
}

function processTable(): ProcessTable {
  const table: ProcessTable = { cpu: new Map(), children: new Map() };
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const pid = Number(entry);
      table.cpu.set(pid, (Number(fields[11]) + Number(fields[12])) * (1_000_000 / CLOCK_TICKS_PER_SECOND));
      const siblings = table.children.get(Number(fields[1])) ?? [];
      siblings.push(pid);
      table.children.set(Number(fields[1]), siblings);
    } catch { /* The process exited while it was being read. */ }
  }
  return table;
}

// CPU time of a process and its descendants, and of the process alone.
function treeCpu(rootPid: number): { total: number; root: number } {
  const { cpu, children } = processTable();
  let total = 0;
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    total += cpu.get(pid) ?? 0;
    pending.push(...(children.get(pid) ?? []));
  }
  return { total, root: cpu.get(rootPid) ?? 0 };
}

function residentMegabytes(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  return Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0) / 1024;
}

function originalChild(pid: number): number | null {
  return processTable().children.get(pid)?.[0] ?? null;
}

async function measure(server: StartedServer, configuration: Configuration, scenario: Scenario, seconds: number, warmup: number): Promise<Measurement> {
  const scheme = scenario.mode === 'ws' ? server.baseUrl.replace(/^http/, 'ws') : server.baseUrl;
  const child = Bun.spawn([benchBinary, scenario.mode, `${scheme}${scenario.path}`, ...scenario.args(server),
    '--concurrency', String(scenario.concurrency), '--seconds', String(seconds), '--warmup', String(warmup)], { stdout: 'pipe', stderr: 'pipe' });
  await Bun.sleep(warmup * 1000);
  const before = treeCpu(server.pid);
  await Bun.sleep(seconds * 1000);
  const after = treeCpu(server.pid);
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`garcon-bench failed: ${await new Response(child.stderr).text()}`);
  const result = JSON.parse(output) as { requests: number; requestsPerSecond: number; megabytesPerSecond: number; p50Micros: number; p99Micros: number; errors: number };
  const total = after.total - before.total;
  const isFrontDoor = configuration.build.label !== 'original';
  return {
    requestsPerSecond: result.requestsPerSecond,
    megabytesPerSecond: result.megabytesPerSecond,
    p50Micros: result.p50Micros,
    p99Micros: result.p99Micros,
    errors: result.errors,
    cpuMicrosPerRequest: result.requests > 0 ? total / result.requests : 0,
    frontDoorCpuShare: isFrontDoor && total > 0 ? (after.root - before.root) / total : null,
  };
}

function append<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;

function format(value: number, digits = 0): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function commandOutput(command: string[], cwd = repoRoot): string {
  try {
    const result = Bun.spawnSync(command, { cwd });
    return result.exitCode === 0 ? result.stdout.toString().trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    repetitions: { type: 'string', default: '3' },
    seconds: { type: 'string', default: '5' },
    warmup: { type: 'string', default: '1' },
    output: { type: 'string', default: 'rust/BENCHMARKS.md' },
  },
});
const repetitions = Number(values.repetitions);
const seconds = Number(values.seconds);
const warmup = Number(values.warmup);
for (const required of [benchBinary, join(repoRoot, frontDoorBinary), join(webBuildDir, 'index.html')]) {
  if (!existsSync(required)) throw new Error(`Missing ${relative(repoRoot, required)}; run bun run build and bun run rust:build`);
}
const asset = assets();
const plan = scenarios(asset);

// Startup is measured on fresh servers, which are then discarded.
const startup = new Map<string, number[]>();
for (let round = 0; round < repetitions; round++) {
  for (const configuration of configurations) {
    const server = await startServer(repoRoot, configuration.build, { webBuildDir, environment: configuration.environment });
    append(startup, configuration.name, server.startupMs);
    await server.stop();
  }
}

const servers = new Map<string, StartedServer>();
for (const configuration of configurations) {
  servers.set(configuration.name, await startServer(repoRoot, configuration.build, { webBuildDir, environment: configuration.environment }));
}
// Lets startup work such as provider discovery finish before measuring.
await Bun.sleep(5000);
const results = new Map<string, Measurement[]>();
for (const scenario of plan) {
  for (let round = 0; round < repetitions; round++) {
    // Rotating the order spreads drift on the shared machine across configurations.
    for (let offset = 0; offset < configurations.length; offset++) {
      const configuration = configurations[(round + offset) % configurations.length]!;
      const key = `${scenario.name}|${configuration.name}`;
      const measurement = await measure(servers.get(configuration.name)!, configuration, scenario, seconds, warmup);
      append(results, key, measurement);
      console.log(`${scenario.name} / ${configuration.name}: ${format(measurement.requestsPerSecond)} req/s, p50 ${measurement.p50Micros} us`);
    }
  }
}
const memory = new Map<string, string>();
for (const configuration of configurations) {
  const server = servers.get(configuration.name)!;
  if (configuration.build.label === 'original') {
    memory.set(configuration.name, `${format(residentMegabytes(server.pid))} MB`);
  } else {
    const child = originalChild(server.pid);
    memory.set(configuration.name, `${format(residentMegabytes(server.pid), 1)} MB front door + ${child ? format(residentMegabytes(child)) : '?'} MB original`);
  }
}
for (const server of servers.values()) await server.stop();

const lines: string[] = [];
const cpuModel = cpus()[0]?.model ?? 'unknown';
lines.push('# Benchmarks', '');
lines.push('The TypeScript original compared with the Rust front door, with its native units on and with every request sent to the original. Generated by `bun rust/parity/bench.ts`; see [README](README.md).', '');
lines.push('## Method', '');
lines.push(`- Machine: ${cpuModel}, ${cpus().length} cores, Linux ${release()}. Bun ${Bun.version}, ${commandOutput(['rustc', '--version'], join(repoRoot, 'rust'))}.`);
lines.push(`- Each server runs in isolated directories with authentication enabled and serves the production web build. All three run at once and are measured in rotating order; each number is the median of ${repetitions} runs of ${seconds} s after ${warmup} s of warm-up.`);
lines.push('- Load comes from `garcon-bench` (`rust/garcon-bench`) on the same machine, so the load generator competes with the servers for CPU. Each client holds one keep-alive connection and sends its next request when the previous response has been read completely.');
lines.push('- CPU per request is the user and system time of the server process tree (front door, original, and their children) during the measured window, divided by the requests completed. "Front door share" is the part of that spent in the Rust process.');
lines.push('');
lines.push('## Results', '');
lines.push('| Scenario | Configuration | Requests/s | MB/s | p50 latency | p99 latency | CPU per request | Front door share | Errors |');
lines.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
for (const scenario of plan) {
  const originalRate = median(results.get(`${scenario.name}|original`)!.map((entry) => entry.requestsPerSecond));
  for (const configuration of configurations) {
    const runs = results.get(`${scenario.name}|${configuration.name}`)!;
    const rate = median(runs.map((entry) => entry.requestsPerSecond));
    const change = configuration.name === 'original' ? '' : ` (${rate >= originalRate ? '+' : ''}${format(((rate - originalRate) / originalRate) * 100)}%)`;
    const share = runs[0]!.frontDoorCpuShare === null ? '' : `${format(median(runs.map((entry) => entry.frontDoorCpuShare ?? 0)) * 100)}%`;
    lines.push(`| ${scenario.name} | ${configuration.name} | ${format(rate)}${change} | ${format(median(runs.map((entry) => entry.megabytesPerSecond)), 1)} | ${format(median(runs.map((entry) => entry.p50Micros)) / 1000, 2)} ms | ${format(median(runs.map((entry) => entry.p99Micros)) / 1000, 2)} ms | ${format(median(runs.map((entry) => entry.cpuMicrosPerRequest)))} us | ${share} | ${runs.reduce((sum, entry) => sum + entry.errors, 0)} |`);
  }
}
lines.push('', 'Scenarios:', '');
for (const scenario of plan.filter((entry, index, all) => all.findIndex((other) => other.description === entry.description) === index)) {
  lines.push(`- ${scenario.description}.`);
}
lines.push('', '## Startup and memory', '');
lines.push('| Configuration | Startup to ready (median) | Resident memory after the run |', '| --- | ---: | ---: |');
for (const configuration of configurations) {
  lines.push(`| ${configuration.name} | ${format(median(startup.get(configuration.name)!))} ms | ${memory.get(configuration.name)} |`);
}
await Bun.write(resolve(repoRoot, values.output!), `${lines.join('\n')}\n`);
console.log(`wrote ${values.output}`);
