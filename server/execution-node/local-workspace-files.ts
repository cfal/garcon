import { promises as fs } from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import { parseSaveTextRequest, type SaveTextRequest } from '../../common/file-contracts.js';
import {
  FileRevisionConflictError,
  type WorkspaceFileService,
  type WorkspaceFileTarget,
} from '../execution-nodes/workspace-files.js';
import {
  FilePathMustIdentifyFileError,
  getFileLockKey,
  getFileRevisionOrMissing,
  readVersionedFile,
  writeVersionedTextFile,
} from '../files/file-revision.js';
import { ProjectUnavailableError, ValidationDomainError } from '../lib/domain-error.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import type { KeyedPromiseLock } from '../lib/keyed-lock.js';
import { resolveRealWithinBase, resolveRealWithinCanonicalBase } from '../lib/path-boundary.js';
import { inspectProjectDirectory } from '../projects/project-directory-service.js';
import { listDirectoryStrict, listWorkspaceFiles } from '../files/directory-listing.js';
import { browseWorkspaceDirectories, readWorkspaceTree } from '../files/workspace-tree.js';

interface LocalWorkspaceFileOptions {
  readonly projectBasePath: string;
  readonly saveLocks: Pick<KeyedPromiseLock, 'runExclusive'>;
  readonly homeDirectoryPath?: string | null;
  readonly listTreeDirectory?: typeof listDirectoryStrict;
  readonly resolveSaveTarget?: typeof resolveRealWithinBase;
}

export class LocalWorkspaceFileService implements WorkspaceFileService {
  readonly #projectBasePath: string;
  readonly #saveLocks: Pick<KeyedPromiseLock, 'runExclusive'>;
  readonly #resolveSaveTarget: typeof resolveRealWithinBase;
  readonly #homeDirectoryPath: string | null;
  readonly #listTreeDirectory: typeof listDirectoryStrict;

  constructor(options: LocalWorkspaceFileOptions) {
    this.#projectBasePath = path.resolve(options.projectBasePath);
    this.#saveLocks = options.saveLocks;
    this.#homeDirectoryPath = options.homeDirectoryPath ?? null;
    this.#listTreeDirectory = options.listTreeDirectory ?? listDirectoryStrict;
    this.#resolveSaveTarget = options.resolveSaveTarget ?? resolveRealWithinBase;
  }

  async tree(directoryPath: string | null, signal: AbortSignal) {
    signal.throwIfAborted();
    const root = await fs.realpath(this.#projectBasePath);
    return readWorkspaceTree(root, this.#homeDirectoryPath, directoryPath, signal, this.#listTreeDirectory);
  }

  async browse(directoryPath: string | null, signal: AbortSignal) {
    signal.throwIfAborted();
    try {
      const root = await fs.realpath(this.#projectBasePath);
      return await browseWorkspaceDirectories(root, directoryPath, signal);
    } catch {
      signal.throwIfAborted();
      return [];
    }
  }

  async list(projectPath: string, signal: AbortSignal) {
    const project = await this.#project(projectPath, signal);
    return listWorkspaceFiles(project, signal);
  }

  async inspectProject(projectPath: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const resolution = await inspectProjectDirectory(projectPath, {
      resolvePath: async (candidate) => {
        const root = await fs.realpath(this.#projectBasePath);
        signal.throwIfAborted();
        return resolveRealWithinCanonicalBase(root, path.resolve(this.#projectBasePath, candidate));
      },
    });
    signal.throwIfAborted();
    return resolution;
  }

  async #project(projectPath: string, signal: AbortSignal): Promise<string> {
    const resolution = await this.inspectProject(projectPath, signal);
    if (resolution.kind === 'unavailable') throw new ProjectUnavailableError(projectPath, resolution.reason);
    return resolution.effectiveProjectKey;
  }

  async #file(target: WorkspaceFileTarget, signal: AbortSignal): Promise<string> {
    const { projectPath, filePath } = target;
    if (!filePath) throw new ValidationDomainError('Invalid file path');
    const project = await this.#project(projectPath, signal);
    const resolved = await resolveRealWithinBase(project, filePath);
    signal.throwIfAborted();
    return resolved;
  }

  async identity(target: WorkspaceFileTarget, signal: AbortSignal) {
    const { projectPath, filePath } = target;
    signal.throwIfAborted();
    if (!filePath || path.isAbsolute(filePath)) throw new ValidationDomainError('A relative file path is required');
    const normalized = path.normalize(filePath);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new ValidationDomainError('A valid relative file path is required');
    }
    const project = await this.#project(projectPath, signal);
    const resolved = await resolveRealWithinBase(project, normalized);
    signal.throwIfAborted();
    if (!(await fs.stat(resolved)).isFile()) throw new FilePathMustIdentifyFileError();
    signal.throwIfAborted();
    return {
      success: true as const,
      identity: {
        canonicalFileRootPath: project,
        normalizedRelativePath: path.relative(project, resolved).split(path.sep).join('/'),
      },
    };
  }

  async readText(target: WorkspaceFileTarget, signal: AbortSignal) {
    const resolved = await this.#file(target, signal);
    const { bytes, revision } = await readVersionedFile(resolved);
    signal.throwIfAborted();
    return { content: bytes.toString('utf8'), path: resolved, revision };
  }

  async revision(target: WorkspaceFileTarget, signal: AbortSignal) {
    const resolved = await this.#file(target, signal);
    const revision = await getFileRevisionOrMissing(resolved);
    signal.throwIfAborted();
    return revision ? { status: 'ready' as const, revision } : { status: 'missing' as const };
  }

  async content(target: WorkspaceFileTarget, signal: AbortSignal) {
    const resolved = await this.#file(target, signal);
    const { bytes, revision } = await readVersionedFile(resolved);
    signal.throwIfAborted();
    return {
      bytes: bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : Uint8Array.from(bytes),
      mimeType: mime.lookup(resolved) || 'application/octet-stream',
      revision,
    };
  }

  async saveText(target: WorkspaceFileTarget, request: SaveTextRequest, signal: AbortSignal) {
    const { projectPath, filePath } = target;
    const captured = parseSaveTextRequest(request);
    if (!filePath) throw new ValidationDomainError('Invalid file path');
    if (!captured) throw new ValidationDomainError('Content, expectedRevision, and conflictResolution are required');
    try {
      const project = await this.#project(projectPath, signal);
      const resolved = await this.#resolveSaveTarget(project, filePath);
      signal.throwIfAborted();
      const lockKey = await getFileLockKey(resolved);
      signal.throwIfAborted();
      return await this.#saveLocks.runExclusive(lockKey, async () => {
        signal.throwIfAborted();
        const lockedPath = await this.#resolveSaveTarget(project, filePath);
        const lockedKey = await getFileLockKey(lockedPath);
        signal.throwIfAborted();
        if (lockedPath !== resolved || lockedKey !== lockKey) throw new FileRevisionConflictError();
        const currentRevision = await getFileRevisionOrMissing(resolved);
        signal.throwIfAborted();
        if (captured.conflictResolution === 'reject' && currentRevision !== captured.expectedRevision) {
          throw new FileRevisionConflictError();
        }
        // Once writing begins, cancellation cannot claim that the mutation did not occur.
        const revision = await writeVersionedTextFile(resolved, captured.content);
        return { success: true as const, path: resolved, message: 'File saved successfully', revision };
      }, signal);
    } catch (error) {
      if (hasNodeErrorCode(error, 'ELOOP')) throw new FileRevisionConflictError();
      throw error;
    }
  }
}
