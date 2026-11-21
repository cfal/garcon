// Installs the pinned Antigravity CLI used by the scripted-model integration
// tier and prints its path. The archive comes from Google's public release
// bucket and is verified against the SHA-512 its release manifest published.
//
//   bun scripts/install-antigravity-cli.ts [cache-dir]
//   export ANTIGRAVITY_BIN="$(bun scripts/install-antigravity-cli.ts)"

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ANTIGRAVITY_CLI_RELEASE = {
  version: '1.5.13',
  platform: 'linux-x64',
  url: 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.13-5999302598852608/linux-x64/cli_linux_x64.tar.gz',
  sha512: '014b37387703acab1f47cd532c8bb60167a6a3537b0f9891de03f1b1ffa9614307bc83c4b2f7551273b0877d722716b0cd9e26782f6b2a50705db4f05e18c68f',
  // The archive holds exactly this one executable.
  member: 'antigravity',
  // The extracted executable. agy can replace its own binary, so a cached copy
  // is trusted only while it still matches.
  binarySha512: 'fe899320c794f68ae843466b8644b210b225a47b55a12995a0e0d1cef66d205fe3888efd011abe57914e8c9391623a1ec729b6abaaf09ebc82ce149747fb5029',
} as const;

async function fileSha512(path: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function run(command: string[]): Promise<Uint8Array> {
  const proc = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${command.join(' ')} failed (${exitCode}): ${stderr.trim()}`);
  return stdout;
}

export async function installAntigravityCli(cacheRoot: string): Promise<string> {
  const release = ANTIGRAVITY_CLI_RELEASE;
  if (`${process.platform}-${process.arch}` !== release.platform) {
    throw new Error(`The pinned Antigravity CLI is only installed for ${release.platform}.`);
  }
  const directory = join(cacheRoot, release.version);
  const binary = join(directory, 'agy');
  if (await Bun.file(binary).exists() && await fileSha512(binary) === release.binarySha512) {
    await chmod(binary, 0o755);
    return binary;
  }

  await mkdir(directory, { recursive: true });
  // Concurrent cold installs publish only complete, verified binaries by rename.
  const staging = await mkdtemp(join(directory, '.install-'));
  try {
    const archive = join(staging, 'cli.tar.gz');
    const response = await fetch(release.url);
    if (!response.ok) throw new Error(`Downloading ${release.url} failed with HTTP ${response.status}.`);
    await Bun.write(archive, response);
    const digest = await fileSha512(archive);
    if (digest !== release.sha512) {
      throw new Error(`Antigravity CLI archive SHA-512 mismatch: expected ${release.sha512}, received ${digest}.`);
    }
    const members = new TextDecoder().decode(await run(['tar', '-tzf', archive])).trim().split('\n');
    if (members.length !== 1 || members[0] !== release.member) {
      throw new Error(`Unexpected Antigravity CLI archive members: ${members.join(', ')}`);
    }
    const staged = join(staging, release.member);
    await run(['tar', '-xzf', archive, '-C', staging, release.member]);
    if (await fileSha512(staged) !== release.binarySha512) {
      throw new Error('The extracted Antigravity CLI does not match its pinned SHA-512.');
    }
    await chmod(staged, 0o755);
    await rename(staged, binary);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return binary;
}

if (import.meta.main) {
  const cacheRoot = process.argv[2] ?? join(homedir(), '.cache', 'garcon-antigravity-cli');
  console.log(await installAntigravityCli(cacheRoot));
}
