import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ExecutionFilesService, ExecutionFileTarget, ExecutorCallOptions } from '@garcon/server-agent-interface';
import { MAX_FILE_SAVE_BYTES, parseSaveTextRequest, type FileTreeHomeDirectory } from '../../../common/file-contracts.js';
import { assertRealWithinBase, resolveRealWithinBase } from '../../common/path-boundary.js';
import { DomainError, ValidationDomainError } from '../../common/domain-error.js';
import { KeyedPromiseLock } from '../../common/keyed-lock.js';
import { toNativePath, toExecutorPath } from '../../common/executor-path.js';
import { readVersionedFile, getFileRevisionOrMissing, getFileLockKey, writeVersionedTextFile, FileTooLargeError } from './file-revision.js';
import { readDirectoryCandidates, fileBreadcrumbs, listProjectFiles, readFileDirectory, relativeFilePath } from './directory-reader.js';
import { fileOperationError, fileRevisionConflict } from './errors.js';

export interface FilesServiceOptions {
  readonly executorId: string;
  readonly projectBasePath: string;
  readonly homeDirectory?: string;
  readonly assertAvailable?: (options?: ExecutorCallOptions) => void;
  readonly resolveSaveTarget?: typeof resolveRealWithinBase;
  readonly readDirectory?: typeof readFileDirectory;
}

// In-flight writes can outlive a serving session, so aliases share process-lifetime locks.
const saveLocks = new KeyedPromiseLock();
let activeContentOperations = 0;
const MAX_FILE_CONTENT_OPERATIONS = 8;

export class FilesService implements ExecutionFilesService {
  constructor(private readonly options: FilesServiceOptions) {}

  async tree(request: Parameters<ExecutionFilesService['tree']>[0], options?: ExecutorCallOptions) {
    return this.#run(options, async () => {
      const { root, directory } = await this.#directory(request.directoryPath);
      let homeDirectory: FileTreeHomeDirectory | null = null;
      try {
        const home = await assertRealWithinBase(root, this.options.homeDirectory ?? os.homedir());
        if ((await fs.stat(home)).isDirectory()) homeDirectory = { path: toExecutorPath(home), breadcrumbs: fileBreadcrumbs(root, home) };
      } catch { /* Home is optional and must remain within this executor's base. */ }
      const entries = await (this.options.readDirectory ?? readFileDirectory)(root, directory, options?.signal);
      return {
        fileRootPath: toExecutorPath(root), homeDirectory,
        directory: { path: toExecutorPath(directory), relativePath: relativeFilePath(root, directory), parentPath: directory === root ? null : toExecutorPath(path.dirname(directory)), breadcrumbs: fileBreadcrumbs(root, directory) },
        entries,
      };
    });
  }

  async browse(request: Parameters<ExecutionFilesService['browse']>[0], options?: ExecutorCallOptions) {
    return this.#run(options, async () => {
      const { root, directory } = await this.#directory(request.directoryPath);
      return readDirectoryCandidates(root, directory, options?.signal);
    });
  }

  async list(request: Parameters<ExecutionFilesService['list']>[0], options?: ExecutorCallOptions) {
    return this.#run(options, async () => listProjectFiles(await this.#root(request.projectPath), options?.signal));
  }

  async identity(request: ExecutionFileTarget, options?: ExecutorCallOptions) {
    return this.#run(options, async () => {
      this.#validateTarget(request);
      const input = toNativePath(request.filePath);
      if (!input || path.isAbsolute(input) || path.normalize(input) === '.' || path.normalize(input) === '..' || path.normalize(input).startsWith(`..${path.sep}`)) {
        throw new ValidationDomainError('A valid relative file path is required');
      }
      const root = await this.#root(request.projectPath);
      const target = await resolveRealWithinBase(root, input);
      if (!(await fs.stat(target)).isFile()) throw new DomainError('FILE_PATH_MUST_IDENTIFY_FILE', 'File path must identify a file', 400);
      return { executorId: this.options.executorId, canonicalFileRootPath: toExecutorPath(root), normalizedRelativePath: relativeFilePath(root, target) };
    });
  }

  async revision(request: ExecutionFileTarget, options?: ExecutorCallOptions) {
    return this.#run(options, async () => {
      const revision = await getFileRevisionOrMissing(await this.#target(request));
      return revision ? { status: 'ready' as const, revision } : { status: 'missing' as const };
    });
  }

  async read(request: ExecutionFileTarget, options?: ExecutorCallOptions) {
    return this.#runContent(options, async () => {
      const target = await this.#target(request);
      const result = await readVersionedFile(target);
      return { ...result, path: toExecutorPath(target) };
    });
  }

  async save(request: Parameters<ExecutionFilesService['save']>[0], options?: ExecutorCallOptions) {
    return this.#runContent(options, async () => {
      this.#validateTarget(request);
      if (!parseSaveTextRequest(request)) throw new ValidationDomainError('Content, expectedRevision, and conflictResolution are required');
      if (Buffer.byteLength(request.content) > MAX_FILE_SAVE_BYTES) throw new FileTooLargeError(MAX_FILE_SAVE_BYTES);
      const root = await this.#root(request.projectPath);
      const resolve = this.options.resolveSaveTarget ?? resolveRealWithinBase;
      const target = await resolve(root, toNativePath(request.filePath));
      const key = await getFileLockKey(target);
      return saveLocks.runExclusive(key, async () => {
        this.#available(options);
        const locked = await resolve(root, toNativePath(request.filePath));
        if (locked !== target || await getFileLockKey(locked) !== key) throw fileRevisionConflict();
        const current = await getFileRevisionOrMissing(target);
        if (request.conflictResolution === 'reject' && current !== request.expectedRevision) throw fileRevisionConflict();
        this.#available(options);
        const revision = await writeVersionedTextFile(target, request.content);
        return { success: true as const, path: toExecutorPath(target), message: 'File saved successfully', revision };
      });
    });
  }

  async #directory(input?: string) {
    const root = await this.#root(this.options.projectBasePath);
    const directory = await assertRealWithinBase(root, toNativePath(input || root));
    if (!(await fs.stat(directory)).isDirectory()) throw new DomainError('FILE_DIRECTORY_REQUIRED', 'File tree path must identify a directory', 400);
    return { root, directory };
  }

  async #root(input: string): Promise<string> {
    if (typeof input !== 'string' || !input || input.length > 4096 || input.includes('\0')) throw new ValidationDomainError('Invalid project path');
    return assertRealWithinBase(toNativePath(this.options.projectBasePath), toNativePath(input));
  }

  async #target(request: ExecutionFileTarget): Promise<string> {
    this.#validateTarget(request);
    return resolveRealWithinBase(await this.#root(request.projectPath), toNativePath(request.filePath));
  }

  #validateTarget(request: ExecutionFileTarget): void {
    if (typeof request.filePath !== 'string' || !request.filePath || request.filePath.length > 4096 || request.filePath.includes('\0')) throw new ValidationDomainError('Invalid file path');
  }

  #available(options?: ExecutorCallOptions): void {
    options?.signal?.throwIfAborted();
    this.options.assertAvailable?.(options);
  }

  async #run<T>(options: ExecutorCallOptions | undefined, operation: () => Promise<T>): Promise<T> {
    this.#available(options);
    try { return await operation(); }
    catch (error) { throw fileOperationError(error); }
  }

  async #runContent<T>(options: ExecutorCallOptions | undefined, operation: () => Promise<T>): Promise<T> {
    return this.#run(options, async () => {
      if (activeContentOperations >= MAX_FILE_CONTENT_OPERATIONS) throw new DomainError('FILE_SERVICE_BUSY', 'Too many active file reads or saves', 503, true);
      activeContentOperations++;
      try { return await operation(); }
      finally { activeContentOperations--; }
    });
  }
}
