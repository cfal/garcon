import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function parseHostname(value) {
  const hostname = value.trim().toLowerCase();
  if (hostname.length > 253 || !hostname.includes('.') || !hostname.split('.').every(
    label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
  ) || /^\d+(\.\d+){3}$/.test(hostname)) {
    throw new Error('Enter a hostname such as garcon.example.com, without https:// or a path.');
  }
  return hostname;
}

export function parseOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use a local HTTP origin such as http://127.0.0.1:8080 (no path).');
  }
  return url.origin;
}

export async function checkAuthentication(origin, fetcher = fetch) {
  const response = await fetcher(`${origin}/api/v1/auth/status`, {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Garcon did not return a successful authentication status.');
  const status = await response.json();
  if (status.authDisabled !== false || status.needsSetup !== false) {
    throw new Error(`Create your Garcon account at ${origin}/setup and enable authentication before connecting a domain.`);
  }
}

export async function readOptional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeOwnedFile(file, content) {
  const existing = await readOptional(file);
  if (existing !== null) {
    if (existing !== content) throw new Error(`Refusing to replace existing configuration: ${file}`);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, content, { flag: 'wx', mode: 0o600 });
}

export async function runCommand(command) {
  const child = Bun.spawn(command, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  if (await child.exited !== 0) throw new Error(`${path.basename(command[0])} failed. Resolve the error above and rerun setup:tunnel.`);
}

export async function connectTunnel({ directory, hostname, origin, cloudflared, run = runCommand, check = checkAuthentication }) {
  hostname = parseHostname(hostname);
  origin = parseOrigin(origin);
  await check(origin);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const credentials = path.join(directory, 'credentials.json');
  const config = path.join(directory, 'config.yml');
  if (await readOptional(credentials) === null) {
    await run([cloudflared, 'tunnel', 'create', '--credentials-file', credentials, `garcon-${hostname}`]);
  }
  const { TunnelID: id } = JSON.parse(await readFile(credentials, 'utf8'));
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) {
    throw new Error('Invalid tunnel credentials. Keep the file private; recover it through Cloudflare.');
  }
  if (process.platform !== 'win32') await chmod(credentials, 0o600);
  // JSON is valid YAML and preserves Windows paths without shell or YAML interpolation.
  await writeOwnedFile(config, `${JSON.stringify({
    tunnel: id, 'credentials-file': credentials,
    ingress: [{ hostname, service: origin }, { service: 'http_status:404' }],
  }, null, 2)}\n`);
  await run([cloudflared, 'tunnel', '--config', config, 'ingress', 'validate']);
  await check(origin);
  // An identical DNS route is unchanged: https://github.com/cloudflare/cloudflared/blob/b0297f0b24c60a4cef743b7b878e2da3798cb839/cfapi/hostname.go#L81-L91
  await run([cloudflared, 'tunnel', 'route', 'dns', id, hostname]);
  return { config, id, command: [cloudflared, 'tunnel', '--config', config, 'run', id] };
}
