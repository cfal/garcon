import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileTransfers } from '../file-transfers.js';
import { LocalExecutionFilesService } from '../../files/service.js';
import { FILE_CHUNK_BYTES } from '../file-protocol.js';

let directory: string;
let files: LocalExecutionFilesService;
let transfers: FileTransfers;
const signal = new AbortController().signal;
const scope = { nodeId: 'test-node', instanceId: 'test-generation', sessionId: 'test-session' };
const target = () => ({ projectPath: directory, filePath: 'example.txt' });
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-transfer-test-'));
  await fs.writeFile(path.join(directory, 'example.txt'), 'original');
  files = new LocalExecutionFilesService({ nodeId: scope.nodeId, projectBasePath: directory });
  transfers = new FileTransfers(files, scope, { stagingRoot: path.join(directory, 'staging') });
});
afterEach(async () => { await transfers.dispose(); await fs.rm(directory, { recursive: true, force: true }); });

test('read chunks retain one snapshot and reject foreign session handles', async () => {
  const text = 'x'.repeat(FILE_CHUNK_BYTES + 3);
  await fs.writeFile(path.join(directory, 'example.txt'), text);
  const opened = await transfers.openRead(target(), signal);
  await fs.writeFile(path.join(directory, 'example.txt'), 'replacement');
  const first = await transfers.readChunk({ transfer: opened.transfer, offset: 0 }, signal);
  const last = await transfers.readChunk({ transfer: opened.transfer, offset: FILE_CHUNK_BYTES }, signal);
  expect(Buffer.from(first.data, 'base64').length).toBe(FILE_CHUNK_BYTES);
  expect(Buffer.from(last.data, 'base64').toString()).toBe('xxx');
  expect(last.eof).toBe(true);
  await expect(transfers.readChunk({ transfer: { ...opened.transfer, sessionId: 'other' }, offset: 0 }, signal)).rejects.toMatchObject({ code: 'FILE_TRANSFER_INVALID' });
  await transfers.close(opened.transfer);
  await transfers.close(opened.transfer);
  await expect(transfers.readChunk({ transfer: opened.transfer, offset: 0 }, signal)).rejects.toMatchObject({ code: 'FILE_TRANSFER_EXPIRED' });
});

test('writes stage ordered bytes, reject incomplete commit and check revision at commit', async () => {
  const { revision } = await files.read(target());
  const transfer = await transfers.beginWrite({ ...target(), size: 7, expectedRevision: revision, conflictResolution: 'reject' }, signal);
  await expect(transfers.commitWrite(transfer, signal)).rejects.toMatchObject({ code: 'FILE_TRANSFER_INVALID' });
  await expect(transfers.writeChunk({ transfer, offset: 1, data: 'bmV3' }, signal)).rejects.toMatchObject({ code: 'FILE_TRANSFER_INVALID' });
  await transfers.writeChunk({ transfer, offset: 0, data: Buffer.from('changed').toString('base64') }, signal);
  expect(await fs.readFile(path.join(directory, 'example.txt'), 'utf8')).toBe('original');
  await fs.writeFile(path.join(directory, 'example.txt'), 'external');
  await expect(transfers.commitWrite(transfer, signal)).rejects.toMatchObject({ code: 'FILE_REVISION_CONFLICT' });
  expect(await fs.readFile(path.join(directory, 'example.txt'), 'utf8')).toBe('external');
  expect(await fs.readdir(path.join(directory, 'staging'))).toEqual([]);
});

test('commits empty files and UTF-8 bytes once, preserving returned revision', async () => {
  for (const content of ['', 'text \u{1F642}']) {
    const bytes = Buffer.from(content);
    const { revision } = await files.read(target());
    const transfer = await transfers.beginWrite({ ...target(), size: bytes.length, expectedRevision: revision, conflictResolution: 'reject' }, signal);
    if (bytes.length) await transfers.writeChunk({ transfer, offset: 0, data: bytes.toString('base64') }, signal);
    const saved = await transfers.commitWrite(transfer, signal);
    expect(await files.revision(target())).toEqual({ status: 'ready', revision: saved.revision });
    expect(await fs.readFile(path.join(directory, 'example.txt'), 'utf8')).toBe(content);
    await expect(transfers.commitWrite(transfer, signal)).rejects.toMatchObject({ code: 'FILE_TRANSFER_EXPIRED' });
  }
});

test('malformed or oversized chunks never touch the destination; disposal removes staging', async () => {
  const transfer = await transfers.beginWrite({ ...target(), size: 1, expectedRevision: 'v1:initial', conflictResolution: 'overwrite' }, signal);
  for (const data of ['?', 'eA', Buffer.alloc(FILE_CHUNK_BYTES + 1).toString('base64'), '']) {
    await expect(transfers.writeChunk({ transfer, offset: 0, data }, signal)).rejects.toMatchObject({ code: 'FILE_TRANSFER_INVALID' });
  }
  await expect(transfers.writeChunk({ transfer, offset: 0, data: 'eA==' }, AbortSignal.abort())).rejects.toThrow();
  await transfers.dispose();
  expect(await fs.readdir(path.join(directory, 'staging'))).toEqual([]);
  expect(await fs.readFile(path.join(directory, 'example.txt'), 'utf8')).toBe('original');
});

test('snapshot reservations bound concurrent reads and release on close', async () => {
  const refs = [];
  for (let i = 0; i < 4; i++) refs.push((await transfers.openRead(target(), signal)).transfer);
  await expect(transfers.openRead(target(), signal)).rejects.toMatchObject({ code: 'FILE_TRANSFER_LIMIT' });
  await transfers.close(refs[0]);
  expect((await transfers.openRead(target(), signal)).size).toBe(8);
});
