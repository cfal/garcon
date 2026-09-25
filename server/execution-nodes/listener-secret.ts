import { join } from 'node:path';
import { isRecord } from '../../common/json.js';
import { readJsonStateFile, writeJsonFileAtomic } from '../lib/json-file-store.js';
import { assertPrivateNodeFile } from './config-store.js';
import { createNodeSecret, isNodeSecret } from './connection-url.js';

export async function loadListenerSecret(dataDir: string): Promise<string> {
  const filePath = join(dataDir, 'execution-node-secret.json');
  await assertPrivateNodeFile(filePath);
  let created = false;
  const secret = await readJsonStateFile({
    filePath,
    empty: () => { created = true; return createNodeSecret(); },
    normalize: (value) => {
      if (!isRecord(value) || value.version !== 1 || !isNodeSecret(value.secret)) throw new Error('Invalid execution-node listener credential');
      return value.secret;
    },
  });
  if (created) await writeJsonFileAtomic(filePath, { version: 1, secret }, { mode: 0o600 });
  return secret;
}
