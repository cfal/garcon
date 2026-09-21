import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ExecutionFilesService } from '@garcon/server-agent-interface';
import { MAX_FILE_VIEW_BYTES, MAX_FILE_SAVE_BYTES, isFileRevision } from '../../common/file-contracts.js';
import { DomainError } from '../lib/domain-error.js';
import { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { FILE_CHUNK_BYTES, FILE_TRANSFER_TIMEOUT_MS, decodeFileChunk, invalidFileTransfer, isFileSize, type FileRpcMethods, type FileTransferRef } from './file-protocol.js';

interface Transfer {
  readonly ref: FileTransferRef;
  readonly reserved: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly bytes?: Uint8Array;
  readonly write?: {
    readonly request: FileRpcMethods['files.beginWrite']['request'];
    readonly directory: string;
    readonly file: fs.FileHandle;
    offset: number;
  };
}

export class FileTransfers {
  readonly #transfers = new Map<string, Transfer>();
  readonly #locks = new KeyedPromiseLock();
  #count = 0;
  #bytes = 0;
  #disposed = false;

  constructor(
    private readonly files: ExecutionFilesService,
    private readonly scope: { readonly nodeId: string; readonly instanceId: string; readonly sessionId: string },
    private readonly options: { readonly stagingRoot?: string; readonly timeoutMs?: number } = {},
  ) {}

  async openRead(request: FileRpcMethods['files.openRead']['request'], signal: AbortSignal) {
    const release = this.#reserve(MAX_FILE_VIEW_BYTES);
    try {
      const result = await this.files.read(request, { signal });
      this.#check(signal);
      if (result.bytes.length > MAX_FILE_VIEW_BYTES) throw invalidFileTransfer();
      const transfer = this.#add('file-read', MAX_FILE_VIEW_BYTES, { bytes: result.bytes });
      return { transfer, size: result.bytes.length, path: result.path, revision: result.revision };
    } catch (error) { release(); throw error; }
  }

  async readChunk(request: FileRpcMethods['files.readChunk']['request'], signal: AbortSignal) {
    this.#check(signal);
    const entry = this.#get(request.transfer, 'file-read');
    if (!isFileSize(request.offset) || request.offset > entry.bytes!.length) throw invalidFileTransfer();
    const end = Math.min(request.offset + FILE_CHUNK_BYTES, entry.bytes!.length);
    const data = Buffer.from(entry.bytes!.subarray(request.offset, end)).toString('base64');
    return { offset: request.offset, data, eof: end === entry.bytes!.length };
  }

  async beginWrite(request: FileRpcMethods['files.beginWrite']['request'], signal: AbortSignal) {
    if (!isFileSize(request.size) || request.size > MAX_FILE_SAVE_BYTES || !isFileRevision(request.expectedRevision)
      || !['reject', 'overwrite'].includes(request.conflictResolution)
      || typeof request.projectPath !== 'string' || !request.projectPath || request.projectPath.length > 4096
      || typeof request.filePath !== 'string' || !request.filePath || request.filePath.length > 4096) throw invalidFileTransfer();
    const release = this.#reserve(request.size);
    let directory: string | null = null;
    let file: fs.FileHandle | null = null;
    try {
      this.#check(signal);
      await this.files.revision(request, { signal });
      this.#check(signal);
      const root = this.options.stagingRoot ?? path.join(os.homedir(), '.cache', 'garcon', 'file-transfers');
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      directory = await fs.mkdtemp(path.join(root, 'transfer-'));
      file = await fs.open(path.join(directory, 'content'), 'wx+', 0o600);
      this.#check(signal);
      return this.#add('file-write', request.size, { write: { request: { ...request }, directory, file, offset: 0 } });
    } catch (error) {
      release();
      await file?.close();
      if (directory) await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async writeChunk(request: FileRpcMethods['files.writeChunk']['request'], signal: AbortSignal) {
    const entry = this.#get(request.transfer, 'file-write');
    return this.#locks.runExclusive(entry.ref.id, async () => {
      this.#check(signal);
      this.#get(entry.ref, 'file-write');
      const write = entry.write!;
      const data = decodeFileChunk(request.data);
      if (data.length === 0 || request.offset !== write.offset || data.length + write.offset > write.request.size) throw invalidFileTransfer();
      let accepted = 0;
      while (accepted < data.length) {
        const { bytesWritten } = await write.file.write(data, accepted, data.length - accepted, write.offset + accepted);
        if (!bytesWritten) throw new Error('File staging write made no progress');
        accepted += bytesWritten;
      }
      write.offset += data.length;
      return { nextOffset: write.offset };
    });
  }

  async commitWrite(ref: FileTransferRef, signal: AbortSignal) {
    const entry = this.#get(ref, 'file-write');
    return this.#locks.runExclusive(ref.id, async () => {
      this.#check(signal);
      this.#get(ref, 'file-write');
      const write = entry.write!;
      if (write.offset !== write.request.size) throw invalidFileTransfer();
      try {
        const bytes = await write.file.readFile();
        if (bytes.length !== write.request.size) throw invalidFileTransfer();
        this.#check(signal);
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        return await this.files.save({ ...write.request, content }, { signal });
      } finally { await this.#release(entry); }
    });
  }

  async close(ref: FileTransferRef): Promise<void> {
    this.#validateRef(ref);
    await this.#locks.runExclusive(ref.id, async () => {
      const entry = this.#transfers.get(ref.id);
      if (entry && entry.ref.kind !== ref.kind) throw invalidFileTransfer();
      if (entry) await this.#release(entry);
    });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await Promise.all([...this.#transfers.values()].map((entry) => this.close(entry.ref)));
  }

  #add(kind: FileTransferRef['kind'], reserved: number, value: Pick<Transfer, 'bytes' | 'write'>): FileTransferRef {
    const ref: FileTransferRef = { ...this.scope, kind, id: crypto.randomUUID() };
    const timer = setTimeout(() => { void this.close(ref).catch(() => undefined); }, this.options.timeoutMs ?? FILE_TRANSFER_TIMEOUT_MS);
    timer.unref();
    this.#transfers.set(ref.id, { ...value, ref, reserved, timer });
    return ref;
  }

  #reserve(bytes: number): () => void {
    if (this.#disposed) throw new DomainError('FILE_TRANSFER_EXPIRED', 'File transfer session ended', 409);
    if (this.#count >= 8 || this.#bytes + bytes > 100 * 1024 * 1024) throw new DomainError('FILE_TRANSFER_LIMIT', 'Too many open file transfers', 503, true);
    this.#count++;
    this.#bytes += bytes;
    return () => { this.#count--; this.#bytes -= bytes; };
  }

  #validateRef(ref: FileTransferRef): void {
    if (!ref || ref.nodeId !== this.scope.nodeId || ref.instanceId !== this.scope.instanceId || ref.sessionId !== this.scope.sessionId
      || !['file-read', 'file-write'].includes(ref.kind) || typeof ref.id !== 'string' || ref.id.length > 100) throw invalidFileTransfer();
  }

  #get(ref: FileTransferRef, kind: FileTransferRef['kind']): Transfer {
    this.#validateRef(ref);
    const entry = this.#transfers.get(ref.id);
    if (this.#disposed || !entry) throw new DomainError('FILE_TRANSFER_EXPIRED', 'File transfer expired; reopen the file', 409, true);
    if (ref.kind !== kind || entry.ref.kind !== kind) throw invalidFileTransfer();
    return entry;
  }

  #check(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#disposed) throw new DomainError('FILE_TRANSFER_EXPIRED', 'File transfer session ended', 409);
  }

  async #release(entry: Transfer): Promise<void> {
    clearTimeout(entry.timer);
    this.#transfers.delete(entry.ref.id);
    try {
      if (entry.write) {
        await entry.write.file.close();
        await fs.rm(entry.write.directory, { recursive: true, force: true });
      }
    } finally { this.#count--; this.#bytes -= entry.reserved; }
  }
}
