import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkAuthentication, connectTunnel, parseHostname, parseOrigin } from '../cloudflare-tunnel.js';
import { shouldOfferTunnel } from '../setup-tunnel.js';
import { tunnelService } from '../tunnel-service.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'garcon-tunnel-'));
  roots.push(directory);
  const calls = [];
  let online = true;
  const options = {
    directory, hostname: 'garcon.example.com', origin: 'http://127.0.0.1:8080', cloudflared: '/tools with spaces/cloudflared',
    check: async () => { if (!online) throw new Error('Authentication disabled'); },
    run: async command => {
      calls.push(command);
      if (command[2] === 'create') {
        await writeFile(path.join(directory, 'credentials.json'), JSON.stringify({
          TunnelID: '11111111-2222-3333-4444-555555555555', TunnelSecret: 'synthetic-secret',
        }));
      }
    },
  };
  return { options, calls, goOffline: () => { online = false; } };
}

test('accepts hostnames and loopback origins without accepting URLs, arguments, remote targets or credentials', () => {
  expect(parseHostname(' Garcon.Example.com ')).toBe('garcon.example.com');
  expect(parseOrigin('http://[::1]:8081/')).toBe('http://[::1]:8081');
  for (const value of ['https://garcon.example.com', '*.example.com', '-flag.example.com', 'example.com/path', '127.0.0.1', 'a..com', 'a'.repeat(64) + '.com']) {
    expect(() => parseHostname(value)).toThrow();
  }
  for (const value of ['https://127.0.0.1', 'http://remote.example.com', 'http://user:pass@localhost', 'http://localhost/path', 'http://localhost/?x=1']) {
    expect(() => parseOrigin(value)).toThrow();
  }
});

test('only prompts in an interactive non-CI install', () => {
  expect(shouldOfferTunnel({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: {} })).toBe(true);
  expect(shouldOfferTunnel({ stdin: {}, stdout: { isTTY: true }, env: {} })).toBe(false);
  expect(shouldOfferTunnel({ stdin: { isTTY: true }, stdout: { isTTY: true }, env: { CI: 'true' } })).toBe(false);
});

test('the standalone entry point explains noninteractive use and supports help without starting a tunnel', () => {
  const script = path.resolve(import.meta.dir, '../setup-tunnel.js');
  const rejected = Bun.spawnSync([process.execPath, script], { stdin: 'ignore' });
  expect(rejected.exitCode).toBe(1);
  expect(rejected.stderr.toString()).toContain('interactive terminal');
  const help = Bun.spawnSync([process.execPath, script, '--help'], { stdin: 'ignore' });
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain('--config-dir');
});

test('requires explicit enabled authentication and a completed account before publication', async () => {
  for (const body of [{}, { needsSetup: true, authDisabled: false }, { needsSetup: false, authDisabled: true }]) {
    await expect(checkAuthentication('http://localhost', async () => Response.json(body))).rejects.toThrow('Create your Garcon account');
  }
  await checkAuthentication('http://localhost', async (url, options) => {
    expect(url).toBe('http://localhost/api/v1/auth/status');
    expect(options.redirect).toBe('error');
    return Response.json({ needsSetup: false, authDisabled: false });
  });
  await expect(checkAuthentication('http://localhost', async () => new Response('', { status: 500 }))).rejects.toThrow('successful');
});

test('creates a named tunnel with an exact host and catch-all rejection, then reuses it on rerun', async () => {
  const { options, calls } = await fixture();
  const result = await connectTunnel(options);
  expect(calls[0]).toEqual([options.cloudflared, 'tunnel', 'create', '--credentials-file', path.join(options.directory, 'credentials.json'), 'garcon-garcon.example.com']);
  const config = JSON.parse(await readFile(result.config, 'utf8'));
  expect(config.ingress).toEqual([{ hostname: options.hostname, service: options.origin }, { service: 'http_status:404' }]);
  expect(calls.at(-1)).toEqual([options.cloudflared, 'tunnel', 'route', 'dns', result.id, options.hostname]);
  expect(calls.flat()).not.toContain('--overwrite-dns');
  expect(await readFile(result.config, 'utf8')).not.toContain('synthetic-secret');
  if (process.platform !== 'win32') expect((await stat(path.join(options.directory, 'credentials.json'))).mode & 0o777).toBe(0o600);
  await connectTunnel(options);
  expect(calls.filter(command => command.includes('create'))).toHaveLength(1);
});

test('keeps partial credentials after a DNS failure so rerunning does not create another tunnel', async () => {
  const { options, calls } = await fixture();
  const run = options.run;
  options.run = async command => {
    if (command.includes('dns')) throw new Error('DNS already belongs to another application');
    await run(command);
  };
  await expect(connectTunnel(options)).rejects.toThrow('DNS already belongs');
  options.run = run;
  await connectTunnel(options);
  expect(calls.filter(command => command.includes('create'))).toHaveLength(1);
});

test('does not publish after authentication is disabled or replace an existing configuration', async () => {
  const { options, calls, goOffline } = await fixture();
  const run = options.run;
  options.run = async command => { await run(command); if (command.includes('validate')) goOffline(); };
  await expect(connectTunnel(options)).rejects.toThrow('Authentication disabled');
  expect(calls.some(command => command.includes('dns'))).toBe(false);
  await expect(connectTunnel({ ...options, check: async () => {}, hostname: 'another.example.com' })).rejects.toThrow('Refusing to replace');
  expect(calls.some(command => command.includes('dns'))).toBe(false);
});

test('serializes launchd and systemd arguments without expansion and keeps services at user scope', () => {
  const options = { home: '/home/user', directory: '/home/user/config & files', command: ['/tools/cloudflared', 'tunnel', '--config', '/config/$USER% "quotes"/config.yml', 'run', 'id'], uid: 501 };
  const linux = tunnelService({ ...options, platform: 'linux' });
  expect(linux.files[0][1]).toContain('$$USER%% \\"quotes\\"');
  expect(linux.commands.every(command => command.includes('--user'))).toBe(true);
  const customConfig = tunnelService({ ...options, platform: 'linux', configHome: '/home/user/custom-config' });
  expect(customConfig.files[0][0]).toBe('/home/user/custom-config/systemd/user/garcon-tunnel.service');
  expect(() => tunnelService({ ...options, platform: 'linux', configHome: 'relative' })).toThrow('absolute path');
  const mac = tunnelService({ ...options, platform: 'darwin' });
  expect(mac.files[0][1]).toContain('&amp; files/tunnel.log');
  expect(mac.files[0][1]).toContain('&quot;quotes&quot;');
  expect(mac.bootstrap).toContain('gui/501');
});

test('Windows uses a hidden normal-user task with a restart loop and refuses an unrelated task', () => {
  const service = tunnelService({ platform: 'win32', home: 'C:\\Users\\user', directory: "C:\\Users\\José's folder\\cloudflare", command: ['C:\\tools\\cloudflared.exe', 'tunnel', 'run', 'id'], windowsDirectory: 'C:\\Windows' });
  expect(service.files[0][1]).toContain('Start-Sleep -Seconds 10');
  expect(service.files[0][1]).toContain("$ErrorActionPreference = 'Continue'");
  expect(service.files[0][1]).toContain("José''s folder");
  expect([...Buffer.from(service.files[0][1]).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const registration = Buffer.from(service.commands[0].at(-1), 'base64').toString('utf16le');
  expect(registration).toContain('-RunLevel Limited');
  expect(registration).toContain('-WindowStyle Hidden');
  expect(registration).toContain('-MultipleInstances IgnoreNew');
  expect(registration).toContain('already belongs to another configuration');
  expect(registration).toContain('$existing.Principal.UserId -notin @($user, $identity.User.Value)');
  expect(registration).toContain("$existing.Principal.RunLevel -ne 'Limited'");
  expect(registration).not.toContain('-Force');
});
