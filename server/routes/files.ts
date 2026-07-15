import { promises as fs } from 'fs';
import path from 'path';
import mime from 'mime-types';
import { withJsonBody } from '../lib/json-route.js';
import { listDirectoryNames, listDirectoryStrict } from './projects.utils.js';
import { getProjectBasePath } from '../config.js';
import {
  assertRealWithinProjectBase,
  isProjectBoundaryError,
  isWithinProjectBase,
  projectBoundaryErrorResponse,
  resolveRealWithinBase,
} from '../lib/path-boundary.ts';
import {
  resolveProjectPathFromUrl,
  type ProjectPathResolution,
} from './project-path-resolver.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { IChatRegistry } from '../chats/store.js';
import { asJsonBody, errorMessage, type JsonBody } from './route-helpers.js';
import { createLogger } from '../lib/log.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import {
  AttachmentValidationError,
  MAX_ATTACHMENT_UPLOAD_BODY_BYTES,
  uploadedAttachmentFromFile,
  validateAttachmentUploadBatch,
} from '../attachments/validation.js';
import type {
  FileIdentityResponse,
  FileTreeBreadcrumb,
  FileTreeEntry,
  FileTreeResponse,
} from '../../common/file-contracts.ts';

const logger = createLogger('routes:files');

const FILE_LIST_MAX_DEPTH = 10;
const FILE_LIST_MAX_RESULTS = 10_000;
const FILE_LIST_SKIP_NAMES = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.svn',
  '.hg',
]);

interface FileListItem {
  name: string;
  path: string;
  relativePath: string;
  type: 'file';
}

interface FileListResult {
  files: FileListItem[];
  truncated: boolean;
}

async function listAllFiles(dirPath: string): Promise<FileListResult> {
  const results: FileListItem[] = [];
  const pending: Array<{ dirPath: string; depth: number }> = [
    { dirPath, depth: 0 },
  ];
  let truncated = false;

  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await fs.readdir(current.dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (FILE_LIST_SKIP_NAMES.has(entry.name)) continue;
      const itemPath = path.join(current.dirPath, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < FILE_LIST_MAX_DEPTH) {
          pending.push({ dirPath: itemPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (results.length >= FILE_LIST_MAX_RESULTS) {
        truncated = true;
        pending.length = 0;
        break;
      }
      results.push({
        name: entry.name,
        path: itemPath,
        relativePath: path
          .relative(dirPath, itemPath)
          .split(path.sep)
          .join('/'),
        type: 'file',
      });
    }
  }

  return { files: results, truncated };
}

function portableRelativePath(rootPath: string, targetPath: string): string {
  return path.relative(rootPath, targetPath).split(path.sep).join('/');
}

function buildFileTreeBreadcrumbs(
  rootPath: string,
  targetPath: string,
): FileTreeBreadcrumb[] {
  const breadcrumbs: FileTreeBreadcrumb[] = [
    { name: path.basename(rootPath) || rootPath, path: rootPath },
  ];
  let currentPath = rootPath;
  const relativePath = path.relative(rootPath, targetPath);
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    breadcrumbs.push({ name: segment, path: currentPath });
  }
  return breadcrumbs;
}

export default function createFilesRoutes(registry: IChatRegistry): RouteMap {
  const resolveProjectPath = (url: URL): Promise<ProjectPathResolution> =>
    resolveProjectPathFromUrl(registry, url);

  async function handleTree(_request: Request, url: URL): Promise<Response> {
    try {
      const fileRootPath =
        await assertRealWithinProjectBase(getProjectBasePath());
      const requestedPath = url.searchParams.get('path') || fileRootPath;
      const directoryPath = await assertRealWithinProjectBase(requestedPath);
      const directoryStat = await fs.stat(directoryPath);
      if (!directoryStat.isDirectory()) {
        return jsonError(
          'File tree path must identify a directory',
          400,
          'FILE_TREE_DIRECTORY_REQUIRED',
          false,
        );
      }

      const listedEntries = await listDirectoryStrict(directoryPath, true);
      const entries: FileTreeEntry[] = [];
      for (const entry of listedEntries) {
        try {
          await assertRealWithinProjectBase(entry.path);
          entries.push({
            name: entry.name,
            path: entry.path,
            relativePath: portableRelativePath(fileRootPath, entry.path),
            type: entry.type,
            size: entry.size ?? 0,
            modified: entry.modified ?? null,
            permissionsRwx: entry.permissionsRwx ?? '---------',
          });
        } catch (error) {
          if (!isProjectBoundaryError(error)) throw error;
        }
      }

      const response: FileTreeResponse = {
        fileRootPath,
        directory: {
          path: directoryPath,
          relativePath: portableRelativePath(fileRootPath, directoryPath),
          parentPath:
            directoryPath === fileRootPath ? null : path.dirname(directoryPath),
          breadcrumbs: buildFileTreeBreadcrumbs(fileRootPath, directoryPath),
        },
        entries,
      };
      return Response.json(response);
    } catch (error) {
      if (isProjectBoundaryError(error)) return projectBoundaryErrorResponse();
      if (
        hasNodeErrorCode(error, 'ENOENT') ||
        hasNodeErrorCode(error, 'ENOTDIR')
      ) {
        return jsonError(
          'Directory not found',
          404,
          'FILE_TREE_DIRECTORY_NOT_FOUND',
          false,
        );
      }
      if (
        hasNodeErrorCode(error, 'EACCES') ||
        hasNodeErrorCode(error, 'EPERM')
      ) {
        return jsonError(
          'Permission denied',
          403,
          'FILE_TREE_PERMISSION_DENIED',
          false,
        );
      }
      logger.error('files: file tree error:', errorMessage(error));
      return jsonErrorFromUnknown(error);
    }
  }

  async function handleList(_request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      const { files, truncated } = await listAllFiles(projectPath);
      return Response.json(files, {
        headers: truncated
          ? { 'X-Garcon-File-List-Truncated': 'true' }
          : undefined,
      });
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function handleIdentity(
    _request: Request,
    url: URL,
  ): Promise<Response> {
    const requestedPath = url.searchParams.get('path');
    if (!requestedPath || path.isAbsolute(requestedPath)) {
      return Response.json(
        { error: 'A relative file path is required' },
        { status: 400 },
      );
    }
    const normalizedInput = path.normalize(requestedPath);
    if (
      normalizedInput === '.' ||
      normalizedInput.startsWith(`..${path.sep}`) ||
      normalizedInput === '..'
    ) {
      return Response.json(
        { error: 'A valid relative file path is required' },
        { status: 400 },
      );
    }

    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;
    try {
      const targetPath = await resolveRealWithinBase(
        projectPath,
        normalizedInput,
      );
      const targetStat = await fs.stat(targetPath);
      if (!targetStat.isFile()) {
        return Response.json(
          { error: 'File path must identify a file' },
          { status: 400 },
        );
      }
      const normalizedRelativePath = path
        .relative(projectPath, targetPath)
        .split(path.sep)
        .join('/');
      const response: FileIdentityResponse = {
        success: true,
        identity: {
          canonicalFileRootPath: projectPath,
          normalizedRelativePath,
        },
      };
      return Response.json(response);
    } catch (error) {
      if (isProjectBoundaryError(error)) {
        return Response.json(
          { error: 'Path must be under project root' },
          { status: 403 },
        );
      }
      if (hasNodeErrorCode(error, 'ENOENT')) {
        return Response.json({ error: 'File not found' }, { status: 404 });
      }
      if (hasNodeErrorCode(error, 'EACCES')) {
        return Response.json({ error: 'Permission denied' }, { status: 403 });
      }
      logger.error('files: identity error:', errorMessage(error));
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function getText(_request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      const filePath = url.searchParams.get('path');
      if (!filePath)
        return Response.json({ error: 'Invalid file path' }, { status: 400 });
      const resolvedFile = await resolveRealWithinBase(projectPath, filePath);
      const content = await fs.readFile(resolvedFile, 'utf8');
      return Response.json({ content, path: resolvedFile });
    } catch (error) {
      if (isProjectBoundaryError(error))
        return Response.json(
          { error: 'Path must be under project root' },
          { status: 403 },
        );
      if (hasNodeErrorCode(error, 'ENOENT'))
        return Response.json({ error: 'File not found' }, { status: 404 });
      if (hasNodeErrorCode(error, 'EACCES'))
        return Response.json({ error: 'Permission denied' }, { status: 403 });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function putText(
    body: JsonBody,
    _request: Request,
    url: URL,
  ): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      const filePath = url.searchParams.get('path');
      const { content } = asJsonBody(body);
      if (!filePath)
        return Response.json({ error: 'Invalid file path' }, { status: 400 });
      if (content === undefined)
        return Response.json({ error: 'Content is required' }, { status: 400 });
      const resolvedFile = await resolveRealWithinBase(projectPath, filePath);
      await fs.writeFile(resolvedFile, String(content), 'utf8');
      return Response.json({
        success: true,
        path: resolvedFile,
        message: 'File saved successfully',
      });
    } catch (error) {
      if (isProjectBoundaryError(error))
        return Response.json(
          { error: 'Path must be under project root' },
          { status: 403 },
        );
      if (hasNodeErrorCode(error, 'ENOENT'))
        return Response.json(
          { error: 'File or directory not found' },
          { status: 404 },
        );
      if (hasNodeErrorCode(error, 'EACCES'))
        return Response.json({ error: 'Permission denied' }, { status: 403 });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function handleContent(_request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      const filePath = url.searchParams.get('path');
      if (!filePath)
        return Response.json({ error: 'Invalid file path' }, { status: 400 });
      const resolvedFile = await resolveRealWithinBase(projectPath, filePath);
      await fs.access(resolvedFile);
      const mimeType = mime.lookup(resolvedFile) || 'application/octet-stream';
      const fileBuffer = await fs.readFile(resolvedFile);
      return new Response(fileBuffer, {
        headers: { 'Content-Type': mimeType },
      });
    } catch (error) {
      if (isProjectBoundaryError(error))
        return Response.json(
          { error: 'Path must be under project root' },
          { status: 403 },
        );
      if (hasNodeErrorCode(error, 'ENOENT'))
        return Response.json({ error: 'File not found' }, { status: 404 });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function handleUploadAttachments(request: Request): Promise<Response> {
    try {
      const contentLength = Number.parseInt(
        request.headers.get('content-length') || '',
        10,
      );
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_ATTACHMENT_UPLOAD_BODY_BYTES
      ) {
        return Response.json(
          { error: 'Upload too large. Maximum request size is 30MB.' },
          { status: 413 },
        );
      }

      const formData = await request.formData();
      const entries = [
        ...formData.getAll('attachments'),
        ...formData.getAll('images'),
      ];
      const files = entries.filter(
        (entry): entry is File => entry instanceof File,
      );
      if (files.length === 0)
        return Response.json({ error: 'No files provided' }, { status: 400 });
      validateAttachmentUploadBatch(files);
      const attachments = await Promise.all(
        files.map(uploadedAttachmentFromFile),
      );

      return Response.json({ attachments, images: attachments });
    } catch (error) {
      const status =
        error instanceof AttachmentValidationError ? error.status : 400;
      return Response.json(
        { error: errorMessage(error) || 'Internal server error' },
        { status },
      );
    }
  }

  async function handleBrowse(_request: Request, url: URL): Promise<Response> {
    const dirPath = url.searchParams.get('path') || getProjectBasePath();

    if (!isWithinProjectBase(dirPath)) {
      return Response.json([]);
    }

    let realDirPath: string;
    try {
      realDirPath = await assertRealWithinProjectBase(dirPath);
    } catch {
      return Response.json([]);
    }

    try {
      await fs.access(realDirPath);
    } catch {
      return Response.json([]);
    }

    try {
      const entries = await listDirectoryNames(realDirPath, true);
      const safeEntries = [];
      for (const entry of entries) {
        try {
          await assertRealWithinProjectBase(entry.path);
          safeEntries.push(entry);
        } catch {
          // Drops symlinked or raced entries that no longer stay under the project base.
        }
      }
      return Response.json(safeEntries);
    } catch {
      return Response.json([]);
    }
  }

  return {
    '/api/v1/files/tree': { GET: handleTree },
    '/api/v1/files/list': { GET: handleList },
    '/api/v1/files/identity': { GET: handleIdentity },
    '/api/v1/files/text': { GET: getText, PUT: withJsonBody(putText) },
    '/api/v1/files/content': { GET: handleContent },
    '/api/v1/files/upload-attachments': { POST: handleUploadAttachments },
    '/api/v1/files/upload-images': { POST: handleUploadAttachments },
    '/api/v1/files/browse': { GET: handleBrowse },
  };
}
