import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const output = resolve(root, 'dist');
const icon = resolve(root, '../web/static/icons/icon-512.f6870a9c2dc5.png');
await mkdir(output, { recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(root, 'src/main.js')],
  outdir: output,
  naming: 'launcher.js',
  target: 'browser',
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, 'Launcher build failed');
await cp(resolve(root, 'src/index.html'), resolve(output, 'index.html'));
await cp(resolve(root, 'src/launcher.css'), resolve(output, 'launcher.css'));
await cp(icon, resolve(output, 'icon.png'));
const icons = Bun.spawn(['bun', 'run', 'tauri', 'icon', icon, '--output', 'src-tauri/icons'], {
  cwd: root, stdout: 'inherit', stderr: 'inherit',
});
if (await icons.exited !== 0) throw new Error('Native icon generation failed');
