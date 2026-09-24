import { AgentCallError, type ExecutionFilesService, type NodeCallOptions } from '@garcon/server-agent-interface';
import { MAX_FILE_SAVE_BYTES, isFileRevision, parseSaveTextRequest, parseSaveTextResponse } from '../../common/file-contracts.js';
import { DomainError, ValidationDomainError } from '../lib/domain-error.js';
import type { RemoteSessionBacking } from './remote.js';
import { decodeFileData, invalidFileData } from './file-protocol.js';

export class RemoteExecutionFilesService implements ExecutionFilesService {
  constructor(private readonly backing: () => RemoteSessionBacking) {}

  async tree(request: Parameters<ExecutionFilesService['tree']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.tree', request, options); }
  async browse(request: Parameters<ExecutionFilesService['browse']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.browse', request, options); }
  async list(request: Parameters<ExecutionFilesService['list']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.list', request, options); }
  async identity(request: Parameters<ExecutionFilesService['identity']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.identity', request, options); }
  async revision(request: Parameters<ExecutionFilesService['revision']>[0], options?: NodeCallOptions) { return this.backing().rpc.call('', 'files.revision', request, options); }

  async read(request: Parameters<ExecutionFilesService['read']>[0], options?: NodeCallOptions) {
    const result = await this.backing().rpc.call('', 'files.read', request, { timeoutMs: 30_000, ...options });
    if (!result || !isFileRevision(result.revision) || typeof result.path !== 'string') throw invalidFileData();
    return { bytes: decodeFileData(result.data), path: result.path, revision: result.revision };
  }

  async save(request: Parameters<ExecutionFilesService['save']>[0], options?: NodeCallOptions) {
    if (!parseSaveTextRequest(request)) throw new ValidationDomainError('Content, expectedRevision, and conflictResolution are required');
    if (Buffer.byteLength(request.content) > MAX_FILE_SAVE_BYTES) throw new DomainError('FILE_TOO_LARGE', 'File exceeds the 4 MiB text save limit', 413);
    const { content, ...target } = request;
    try {
      const result = parseSaveTextResponse(await this.backing().rpc.call('', 'files.save', { ...target, data: Buffer.from(content).toString('base64') }, { timeoutMs: 30_000, ...options }));
      if (!result) throw unknownSave();
      return result;
    } catch (error) {
      if (error instanceof AgentCallError && error.outcome === 'unknown') throw unknownSave();
      throw error;
    }
  }
}

function unknownSave(): DomainError {
  return new DomainError('FILE_SAVE_OUTCOME_UNKNOWN', 'Save could not be confirmed. Reload the file before saving again.', 503);
}
