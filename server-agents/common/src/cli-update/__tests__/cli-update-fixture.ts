import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface CliUpdateFixture {
  readonly root: string;
  readonly bin: string;
  readonly env: Record<string, string>;
  writeScript(filePath: string, body: string): Promise<void>;
  // Installs a fake CLI as npm does: `<prefix>/bin/<name>` linking into `lib/node_modules`.
  installNpmCli(options: { readonly name: string; readonly packageName: string; readonly version: string }): Promise<NpmCli>;
  dispose(): Promise<void>;
}

export interface NpmCli {
  readonly prefix: string;
  readonly launcher: string;
  readonly real: string;
  readonly versionFile: string;
}

export async function createCliUpdateFixture(): Promise<CliUpdateFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-cli-update-'));
  const bin = path.join(root, 'tools');
  await mkdir(bin, { recursive: true });
  const writeScript = async (filePath: string, body: string) => {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `#!/bin/sh\n${body}\n`);
    await chmod(filePath, 0o755);
  };
  return {
    root,
    bin,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root },
    writeScript,
    async installNpmCli({ name, packageName, version }) {
      const prefix = path.join(root, 'npm-prefix');
      const real = path.join(prefix, 'lib', 'node_modules', packageName, 'cli.sh');
      const versionFile = path.join(prefix, 'lib', 'node_modules', packageName, 'VERSION');
      await writeScript(real, `cat ${JSON.stringify(versionFile)}`);
      await writeFile(versionFile, `${version} (Synthetic CLI)\n`);
      const launcher = path.join(prefix, 'bin', name);
      await mkdir(path.dirname(launcher), { recursive: true });
      await symlink(real, launcher);
      return { prefix, launcher, real, versionFile };
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
