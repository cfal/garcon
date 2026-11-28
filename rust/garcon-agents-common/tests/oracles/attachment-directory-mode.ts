import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { materializeAttachmentFiles } from '../../../../server-agents/common/src/shared/attachment-files.ts';

process.umask(0);
const materialized = await materializeAttachmentFiles('garcon-attachment-mode-oracle', [
  { data: 'data:text/plain;base64,Ynl0ZXM=', name: 'fixture.txt' },
]);
try {
  const info = await stat(dirname(materialized.files[0]!.path));
  process.stdout.write(JSON.stringify(info.mode & 0o777));
} finally {
  await materialized.cleanup();
}
