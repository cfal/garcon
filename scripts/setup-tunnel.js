import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveConfigDirectory } from '../common/config-dir.ts';
import { checkAuthentication, connectTunnel, parseHostname, parseOrigin, runCommand } from './cloudflare-tunnel.js';
import { installTunnelService } from './tunnel-service.js';

export function shouldOfferTunnel({ stdin = process.stdin, stdout = process.stdout, env = process.env } = {}) {
  return Boolean(stdin.isTTY && stdout.isTTY && !env.CI);
}

export async function setupTunnel(ask, configDir) {
  const cloudflared = Bun.which('cloudflared');
  if (!cloudflared) {
    throw new Error('Install cloudflared first: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/\nThen run: bun run setup:tunnel');
  }
  if (process.getuid?.() === 0) throw new Error('Run tunnel setup as your normal user, without sudo.');
  const hostname = parseHostname(await ask('Custom hostname (for example garcon.example.com): '));
  const origin = parseOrigin((await ask('Local Garcon URL [http://127.0.0.1:8080]: ')) || 'http://127.0.0.1:8080');
  console.log(`Start Garcon at ${origin} in another terminal and finish account setup there first. Leave it running.`);
  await ask('Press Enter when your local Garcon account is ready. ');
  await checkAuthentication(origin);
  console.log(`This will create a Cloudflare tunnel and DNS record for https://${hostname}. Your domain must use Cloudflare DNS.`);
  if (!/^y(es)?$/i.test((await ask('Connect this domain now? [y/N]: ')).trim())) return;
  console.log('Authorize your domain in the browser Cloudflare opens. Existing cloudflared credentials can also be reused.');
  if (!/^y(es)?$/i.test((await ask('Already logged in with cloudflared on this machine? [y/N]: ')).trim())) {
    await runCommand([cloudflared, 'tunnel', 'login']);
  }
  const directory = path.join(resolveConfigDirectory(configDir), 'cloudflare');
  const result = await connectTunnel({ directory, hostname, origin, cloudflared });
  const background = (await ask('Keep the tunnel running in the background and start it at login? [Y/n]: ')).trim();
  if (background === '' || /^y(es)?$/i.test(background)) {
    await installTunnelService({ platform: process.platform, home: homedir(), directory,
      command: result.command, uid: process.getuid?.(), windowsDirectory: process.env.SystemRoot });
    console.log(`Tunnel startup configured. Open https://${hostname} after Cloudflare connects. Sign in with your Garcon account.`);
  } else {
    const quoted = result.command.map(arg => `'${arg.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}'`).join(' ');
    console.log(`Tunnel configured. Run it in a terminal with:\n${process.platform === 'win32' ? '& ' : ''}${quoted}`);
  }
  console.log(`Local tunnel files: ${directory}\nKeep Garcon running separately; the tunnel does not start Garcon.\nStatus, logs, removal, and Docker: docs/cloudflare-tunnel.md`);
}

export async function offerTunnelSetup() {
  if (!shouldOfferTunnel()) return;
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (/^y(es)?$/i.test((await reader.question('Would you like to connect a custom domain with Cloudflare Tunnel? [y/N]: ')).trim())) {
      await setupTunnel(prompt => reader.question(prompt));
    }
  } catch (error) {
    console.error(`Local dependencies are installed. Domain setup did not finish: ${error.message}`);
    console.error('Resume later with bun run setup:tunnel. See docs/cloudflare-tunnel.md.');
  } finally { reader.close(); }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { 'config-dir': { type: 'string' }, help: { type: 'boolean' } }, strict: true });
  if (values.help) {
    console.log('bun run setup:tunnel [--config-dir /absolute/config/path]\nGuided custom-domain setup for a running, authenticated local Garcon server.');
  } else if (!shouldOfferTunnel()) {
    console.error('Domain setup needs an interactive terminal. See docs/cloudflare-tunnel.md for manual setup.');
    process.exitCode = 1;
  } else {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    try { await setupTunnel(prompt => reader.question(prompt), values['config-dir']); }
    catch (error) { console.error(`Domain setup did not finish: ${error.message}`); process.exitCode = 1; }
    finally { reader.close(); }
  }
}
