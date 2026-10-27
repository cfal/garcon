import { coreWireShapes } from './wire-shapes.js';

if (process.argv[2] !== '--establish-core-1') throw new Error('Wire changes require contract review, not routine snapshot updates');
await Bun.write(new URL('./fixtures/core-1-shapes.json', import.meta.url), `${JSON.stringify(coreWireShapes(), null, 2)}\n`);
