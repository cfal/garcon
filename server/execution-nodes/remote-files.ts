import { AgentCallError, type ExecutionFilesService, type NodeCallOptions } from '@garcon/server-agent-interface';
import { MAX_FILE_SAVE_BYTES, isFileRevision, parseSaveTextResponse } from '../../common/file-contracts.js';
import { DomainError } from '../lib/domain-error.js';
import type { RemoteSessionBacking } from './remote.js';
import type { AgentRpc } from './rpc.js';
import { FILE_CHUNK_BYTES, FILE_OPERATION_TIMEOUT_MS, decodeFileChunk, invalidFileTransfer, isFileSize, type FileTransferRef } from './file-protocol.js';

export class RemoteExecutionFilesService implements ExecutionFilesService {
  constructor(private readonly backing: () => RemoteSessionBacking) {}

  async tree(request: Parameters<ExecutionFilesService['tree']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.tree', request, options); }
  async browse(request: Parameters<ExecutionFilesService['browse']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.browse', request, options); }
  async list(request: Parameters<ExecutionFilesService['list']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.list', request, options); }
  async identity(request: Parameters<ExecutionFilesService['identity']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.identity', request, options); }
  async revision(request: Parameters<ExecutionFilesService['revision']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.revision', request, options); }

  async read(request: Parameters<ExecutionFilesService['read']>[0], options?: NodeCallOptions) {
    const { rpc } = this.backing();
    const callOptions = deadline(options);
    const opened = await rpc.call('', 'files.openRead', request, callOptions);
    try {
      if (!isFileSize(opened.size) || !isFileRevision(opened.revision) || typeof opened.path !== 'string') throw invalidFileTransfer();
      const bytes = Buffer.allocUnsafe(opened.size);
      let offset = 0;
      do {
        const chunk = await rpc.call('', 'files.readChunk', { transfer: opened.transfer, offset }, callOptions);
        const data = decodeFileChunk(chunk.data);
        if (chunk.offset !== offset || offset + data.length > bytes.length || chunk.eof !== (offset + data.length === bytes.length)
          || !chunk.eof && data.length === 0) throw invalidFileTransfer();
        bytes.set(data, offset);
        offset += data.length;
        if (chunk.eof) break;
      } while (offset < bytes.length);
      return { bytes, path: opened.path, revision: opened.revision };
    } finally { await closeTransfer(rpc, opened.transfer); }
  }

  async save(request: Parameters<ExecutionFilesService['save']>[0], options?: NodeCallOptions) {
    if (typeof request.content !== 'string' || Buffer.byteLength(request.content) > MAX_FILE_SAVE_BYTES) throw new DomainError('FILE_TOO_LARGE', 'File exceeds the text save limit', 413);
    const { rpc } = this.backing();
    const callOptions = deadline(options);
    const { content, ...target } = request;
    const bytes = Buffer.from(content);
    const transfer = await rpc.call('', 'files.beginWrite', { ...target, size: bytes.length }, callOptions);
    try {
      for (let offset = 0; offset < bytes.length; offset += FILE_CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + FILE_CHUNK_BYTES);
        const reply = await rpc.call('', 'files.writeChunk', { transfer, offset, data: chunk.toString('base64') }, callOptions);
        if (reply.nextOffset !== offset + chunk.length) throw invalidFileTransfer();
      }
      try {
        const result = parseSaveTextResponse(await rpc.call('', 'files.commitWrite', transfer, callOptions));
        if (!result) throw new DomainError('FILE_SAVE_OUTCOME_UNKNOWN', 'Save could not be confirmed. Reload the file before saving again.', 503);
        return result;
      } catch (error) {
        if (error instanceof AgentCallError && error.outcome === 'unknown') {
          throw new DomainError('FILE_SAVE_OUTCOME_UNKNOWN', 'Save could not be confirmed. Reload the file before saving again.', 503);
        }
        throw error;
      }
    } finally { await closeTransfer(rpc, transfer); }
  }
}

function deadline(options?: NodeCallOptions): NodeCallOptions {
  const timeoutMs = options?.timeoutMs ?? FILE_OPERATION_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  return { timeoutMs, signal: options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout };
}

async function closeTransfer(rpc: AgentRpc, transfer: FileTransferRef): Promise<void> {
  try { await rpc.call('', 'files.close', transfer, { timeoutMs: 1000 }); }
  catch { /* Expiry owns cleanup if the peer cannot receive close. */ }
}
