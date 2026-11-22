import { join } from 'node:path';

const binDirectory = join(import.meta.dir, '../node_modules/.bin');
export const CODEX_BINARY = join(binDirectory, 'codex');
export const PI_BINARY = join(binDirectory, 'pi');
