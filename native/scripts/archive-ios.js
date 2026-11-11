import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { findSimulatorApp, validateSimulatorApp } from './ios-app.js';

const root = resolve(import.meta.dir, '..');
const app = findSimulatorApp(root);
await validateSimulatorApp(app, root);
await mkdir(resolve(root, 'artifacts'), { recursive: true });
const archive = Bun.spawn(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', app,
  resolve(root, 'artifacts/Garcon-simulator.app.zip')], { stdout: 'inherit', stderr: 'inherit' });
if (await archive.exited !== 0) throw new Error('Simulator archive failed');
