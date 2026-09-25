import { join } from 'node:path';
import { isRecord } from '../../common/json.js';
import { readJsonStateFile, writeJsonFileAtomic } from '../common/json-file-store.js';
import { assertPrivateFile } from '../common/private-file.js';
import { createExecutorSecret, isExecutorSecret } from './transport/connection-url.js';

export async function loadListenerSecret(dataDir: string): Promise<string> {
  const filePath = join(dataDir, 'executor-secret.json');
  await assertPrivateFile(filePath);
  let created = false;
  const secret = await readJsonStateFile({
    filePath,
    empty: () => { created = true; return createExecutorSecret(); },
    normalize: (value) => {
      if (!isRecord(value) || value.version !== 1 || !isExecutorSecret(value.secret)) throw new Error('Invalid executor listener credential');
      return value.secret;
    },
  });
  if (created) await writeJsonFileAtomic(filePath, { version: 1, secret }, { mode: 0o600 });
  return secret;
}
