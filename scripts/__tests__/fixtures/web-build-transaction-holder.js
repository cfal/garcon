import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureWebBuild } from '../../web-build-coordinator.js';

const root = process.argv[2];
const id = process.argv[3];
if (!root || !id) throw new Error('Fixture root and transaction ID are required');

const input = path.join(root, 'input');
const buildDir = path.join(root, 'build');
const markerPath = path.join(buildDir, '.marker');
const gate = (name) => path.join(root, `${name}.${id}`);

async function waitForGate(name) {
  while (!await fs.stat(gate(name)).catch(() => null)) await Bun.sleep(10);
}

const result = await ensureWebBuild({
  cacheOptions: {
    buildDir,
    environment: { NODE_ENV: 'production' },
    inputs: [input],
    markerPath,
    sourcePath: input,
  },
  lockOptions: {
    lockPath: path.join(root, 'web', '.garcon-web-build.lock'),
    onContention: () => fs.writeFile(gate('waiting'), ''),
    retryDelay: 10,
  },
  compile: async () => {
    const source = await fs.readFile(path.join(input, 'app.ts'), 'utf8');
    await fs.writeFile(gate('ready'), '');
    await waitForGate('publish');
    await fs.rm(buildDir, { recursive: true, force: true });
    await fs.mkdir(buildDir);
    await fs.writeFile(path.join(buildDir, 'app.js'), source);
    return 0;
  },
});
await fs.writeFile(gate('done'), result);
