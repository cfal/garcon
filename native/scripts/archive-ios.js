import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const apps = [...new Bun.Glob('src-tauri/gen/apple/build/**/*.app').scanSync({
  cwd: root, onlyFiles: false, absolute: true,
})].filter(path => !path.includes('.xcarchive/') && path.endsWith('/Garcon.app'));
if (apps.length !== 1) throw new Error(`Expected one exported simulator app, found ${apps.length}`);
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const archive = Bun.spawn(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', apps[0],
  resolve(root, 'artifacts/Garcon-simulator.app.zip')], { stdout: 'inherit', stderr: 'inherit' });
if (await archive.exited !== 0) throw new Error('Simulator archive failed');
