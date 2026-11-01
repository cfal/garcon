import type { ExecutionFileTarget, ExecutionFilesService, ExecutionFileRead } from '@garcon/server-agent-interface';
import { MAX_FILE_VIEW_BYTES, isFileRevision, parseFileTreeResponse, parseFileIdentityResponse,
  parseFileRevisionResponse, parseSaveTextResponse, parseDirectoryEntry } from '../../../common/file-contracts.js';
import { DomainError } from '../../common/domain-error.js';
import { isRecord } from '../../../common/json.js';
import { isExecutorId } from '../../../common/executors.js';

type Call<Q, R> = { readonly request: Q; readonly result: R };
type Method<K extends keyof ExecutionFilesService> = Call<Parameters<ExecutionFilesService[K]>[0], Awaited<ReturnType<ExecutionFilesService[K]>>>;

export interface FileRpcMethods {
  'files.tree': Method<'tree'>;
  'files.browse': Method<'browse'>;
  'files.list': Method<'list'>;
  'files.identity': Method<'identity'>;
  'files.revision': Method<'revision'>;
  'files.read': Call<ExecutionFileTarget, Omit<ExecutionFileRead, 'bytes'> & { readonly data: string }>;
  'files.save': Call<Omit<Parameters<ExecutionFilesService['save']>[0], 'content'> & { readonly data: string }, Awaited<ReturnType<ExecutionFilesService['save']>>>;
  'files.createDirectory': Method<'createDirectory'>;
}

// Base64 keeps even control-heavy UTF-8 below the encoded session limit.
export function decodeFileData(value: unknown): Buffer {
  if (typeof value !== 'string') throw invalidFileData();
  if (value.length > 4 * Math.ceil(MAX_FILE_VIEW_BYTES / 3)) throw new DomainError('FILE_TOO_LARGE', 'File exceeds the 4 MiB limit', 413);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_FILE_VIEW_BYTES) throw new DomainError('FILE_TOO_LARGE', 'File exceeds the 4 MiB limit', 413);
  if (bytes.toString('base64') !== value) throw invalidFileData();
  return bytes;
}

export function decodeFileText(value: unknown): string {
  const bytes = decodeFileData(value);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw invalidFileData(); }
}

export function invalidFileData(): DomainError {
  return new DomainError('FILE_INVALID_DATA', 'Invalid file request or response', 400);
}

export function validateFileRpcRequest(method: string, request: unknown): void {
  if (!isRecord(request)) throw invalidFileData();
  const validPath = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
  if (method === 'files.tree' || method === 'files.browse') {
    if (request.directoryPath !== undefined && !validPath(request.directoryPath)) throw invalidFileData();
  } else if (method === 'files.createDirectory') {
    // The file service decides which names are acceptable; only the shape is checked here.
    if (!validPath(request.parentPath) || typeof request.name !== 'string' || request.name.length > 4096) throw invalidFileData();
  } else {
    if (!validPath(request.projectPath) || method !== 'files.list' && !validPath(request.filePath)) throw invalidFileData();
  }
  if (method === 'files.save' && (!isFileRevision(request.expectedRevision)
    || !['reject', 'overwrite'].includes(request.conflictResolution as string))) throw invalidFileData();
  if (method === 'files.save') decodeFileText(request.data);
}

export function parseFileRpcResultV1(method: keyof FileRpcMethods, value: unknown): unknown {
  const entry = (item: unknown) => isRecord(item) && typeof item.name === 'string' && typeof item.path === 'string'
    && (item.relativePath === undefined || typeof item.relativePath === 'string') && (item.type === 'file' || item.type === 'directory');
  let valid: unknown;
  switch (method) {
    case 'files.tree': valid = parseFileTreeResponse(value); break;
    case 'files.browse': valid = Array.isArray(value) && value.every(entry); break;
    case 'files.list': valid = isRecord(value) && Array.isArray(value.files) && value.files.every(entry) && typeof value.truncated === 'boolean'; break;
    case 'files.identity': valid = isRecord(value) && isExecutorId(value.executorId) && parseFileIdentityResponse({ success: true, identity: value }); break;
    case 'files.revision': valid = parseFileRevisionResponse(value); break;
    case 'files.save':
      if (!parseSaveTextResponse(value)) throw unknownSave();
      return value;
    case 'files.createDirectory':
      if (!parseDirectoryEntry(value)) throw unknownCreation();
      return value;
    case 'files.read':
      valid = isRecord(value) && typeof value.path === 'string' && isFileRevision(value.revision);
      if (valid) decodeFileData((value as Record<string, unknown>).data);
      break;
  }
  if (!valid) throw invalidFileData();
  return value;
}

export function unknownCreation(): DomainError {
  return new DomainError('FILE_CREATE_OUTCOME_UNKNOWN', 'Directory creation could not be confirmed. Refresh the directory before trying again.', 503);
}

export function unknownSave(): DomainError {
  return new DomainError('FILE_SAVE_OUTCOME_UNKNOWN', 'Save could not be confirmed. Reload the file before saving again.', 503);
}
