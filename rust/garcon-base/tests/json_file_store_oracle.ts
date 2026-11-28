import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import {
  CorruptStateFileError,
  readJsonStateFile,
  writeJsonFileAtomic,
} from '../../../server/common/json-file-store.ts';
import { assertPrivateFile } from '../../../server/common/private-file.ts';
import { parseStoredJson } from '../../../server/common/stored-json.ts';

const [operation, filePath] = process.argv.slice(2);
if (!filePath) throw new Error('Expected a state file path');

switch (operation) {
  case 'write':
    await writeJsonFileAtomic(filePath, { z: 1e21, a: [1, 'synthetic'] }, { mode: 0o600, trailingNewline: false });
    break;
  case 'read': {
    await assertPrivateFile(filePath);
    const raw = await readFile(filePath, 'utf8');
    const state = await readJsonStateFile({
      filePath,
      empty: () => null,
      normalize: (value) => value,
    });
    console.log(JSON.stringify({
      raw,
      state,
      parsed: parseStoredJson(raw, basename(filePath)),
      mode: (await stat(filePath)).mode & 0o777,
      entries: (await readdir(dirname(filePath))).sort(),
    }));
    break;
  }
  case 'read-quarantine':
    try {
      await readJsonStateFile({ filePath, empty: () => null, normalize: (value) => value });
      throw new Error('Expected corrupt state');
    } catch (error) {
      if (!(error instanceof CorruptStateFileError)) throw error;
      console.log(error.quarantinePath);
    }
    break;
  default:
    throw new Error(`Unknown operation: ${operation}`);
}
