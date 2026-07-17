import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  FILE_CHANGED_DURING_READ,
  getFileRevision,
  readVersionedFile,
} from '../file-revision.ts';
import { isFileRevision } from '../../../common/file-contracts.ts';

let directory;
let filePath;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-file-revision-'));
  filePath = path.join(directory, 'file.txt');
  await fs.writeFile(filePath, 'first\n', 'utf8');
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('file revision', () => {
  it('keeps a stable opaque revision for an unchanged file', async () => {
    const first = await getFileRevision(filePath);
    const second = await getFileRevision(filePath);

    expect(second).toBe(first);
    expect(isFileRevision(first)).toBe(true);
    expect(first).not.toContain(filePath);
  });

  it('changes the revision when content size changes', async () => {
    const first = await getFileRevision(filePath);
    await fs.writeFile(filePath, 'a longer second value\n', 'utf8');

    expect(await getFileRevision(filePath)).not.toBe(first);
  });

  it('changes the revision after an atomic same-size replacement', async () => {
    const first = await getFileRevision(filePath);
    const replacement = path.join(directory, 'replacement.txt');
    await fs.writeFile(replacement, 'other\n', 'utf8');
    await fs.rename(replacement, filePath);

    expect(await getFileRevision(filePath)).not.toBe(first);
  });

  it('returns bytes with the revision from one stable handle', async () => {
    const result = await readVersionedFile(filePath);

    expect(result.bytes.toString('utf8')).toBe('first\n');
    expect(result.revision).toBe(await getFileRevision(filePath));
  });

  it('fails with a retryable domain error after repeated unstable reads', async () => {
    let statCall = 0;
    let openCall = 0;
    let closeCall = 0;
    const openFile = async () => {
      openCall += 1;
      return {
        async stat() {
          statCall += 1;
          return {
            dev: 1n,
            ino: 2n,
            size: 3n,
            mtimeNs: BigInt(statCall),
            ctimeNs: BigInt(statCall),
            isFile: () => true,
          };
        },
        async readFile() {
          return Buffer.from('value');
        },
        async close() {
          closeCall += 1;
        },
      };
    };

    await expect(
      readVersionedFile(filePath, { maxAttempts: 2, openFile }),
    ).rejects.toMatchObject({
      code: FILE_CHANGED_DURING_READ,
      status: 409,
      retryable: true,
    });
    expect(openCall).toBe(2);
    expect(closeCall).toBe(2);
  });
});
