import { readExecutionNodeConfig } from './config.js';
import { runExecutionWorker } from './worker.js';

const configPath = process.argv[2];
if (!configPath) throw new Error('Use garcon execution-node --help for public worker startup');
await runExecutionWorker(await readExecutionNodeConfig(configPath));
