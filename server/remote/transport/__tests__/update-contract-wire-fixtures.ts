import { mkdir } from 'node:fs/promises';
import { contractWireShapes } from './wire-shapes.js';
import errors from '../rpc-errors-v1.json';

if (process.argv[2] !== '--establish-contracts-v1') throw new Error('Wire changes require contract review, not routine snapshot updates');
const shapes = contractWireShapes();
const directory = new URL('./fixtures/contracts/', import.meta.url);
await mkdir(directory, { recursive: true });
const write = (name: string, value: unknown) => Bun.write(new URL(`./fixtures/${name}.json`, import.meta.url), `${JSON.stringify(value, null, 2)}\n`);
for (const [name, shape] of Object.entries(shapes.contracts)) await write(`contracts/${name}`, shape);
await write('bootstrap-1-shapes', shapes.bootstrap);
await write('cli-bootstrap-1-shapes', shapes.cliBootstrap);
await write('rpc-errors-v1', errors);
