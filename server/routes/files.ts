import { promises as fs } from 'fs';
import path from 'path';
import mime from 'mime-types';
import { withJsonBody } from '../lib/json-route.js';
import { listDirectory, listDirectoryNames } from './projects.utils.js';
import { getProjectBasePath } from '../config.js';
import {
  assertRealWithinProjectBase,
  isProjectBoundaryError,
  isWithinProjectBase,
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

const logger = createLogger('routes:files');

const MAX_ATTACHMENT_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 5;
const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/markdown',
  'text/plain',
  'application/pdf',
]);
const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.markdown': 'text/markdown',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

interface FileListItem {
  name: string;
  path: string;
  relativePath: string;
  type: 'file';
}

async function listAllFiles(
  dirPath: string,
  maxDepth = 10,
  currentDepth = 0,
  rootPath = dirPath,
): Promise<FileListItem[]> {
  const skipNames = new Set(['node_modules', 'dist', 'build', '.git', '.svn', '.hg']);
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: FileListItem[] = [];
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const itemPath = path.join(dirPath, entry.name);
    const isDir = entry.isDirectory();
    if (isDir && currentDepth < maxDepth) {
      const children = await listAllFiles(itemPath, maxDepth, currentDepth + 1, rootPath);
      results.push(...children);
    } else if (entry.isFile()) {
      results.push({
        name: entry.name,
        path: itemPath,
        relativePath: path.relative(rootPath, itemPath).split(path.sep).join('/'),
        type: 'file',
      });
    }
  }
  return results;
}

export default function createFilesRoutes(registry: IChatRegistry): RouteMap {
  const resolveProjectPath = (url: URL): Promise<ProjectPathResolution> =>
    resolveProjectPathFromUrl(registry, url);

  async function handleTree(_request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      let targetDir = projectPath;
      const requestedPath = url.searchParams.get('path');
      if (requestedPath) {
        targetDir = await resolveRealWithinBase(projectPath, requestedPath);
      }
      const files = await listDirectory(targetDir, true);
      return Response.json(files);
    } catch (error) {
      if (isProjectBoundaryError(error)) return Response.json({ error: 'Path must be under project root' }, { status: 403 });
      logger.error('files: file tree error:', errorMessage(error));
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function handleList(_request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      const files = await listAllFiles(projectPath);
      return Response.json(files);
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function getText(_request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      const filePath = url.searchParams.get('path');
      if (!filePath) return Response.json({ error: 'Invalid file path' }, { status: 400 });
      const resolvedFile = await resolveRealWithinBase(projectPath, filePath);
      const content = await fs.readFile(resolvedFile, 'utf8');
      return Response.json({ content, path: resolvedFile });
    } catch (error) {
      if (isProjectBoundaryError(error)) return Response.json({ error: 'Path must be under project root' }, { status: 403 });
      if (hasNodeErrorCode(error, 'ENOENT')) return Response.json({ error: 'File not found' }, { status: 404 });
      if (hasNodeErrorCode(error, 'EACCES')) return Response.json({ error: 'Permission denied' }, { status: 403 });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function putText(body: JsonBody, _request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      const filePath = url.searchParams.get('path');
      const { content } = asJsonBody(body);
      if (!filePath) return Response.json({ error: 'Invalid file path' }, { status: 400 });
      if (content === undefined) return Response.json({ error: 'Content is required' }, { status: 400 });
      const resolvedFile = await resolveRealWithinBase(projectPath, filePath);
      await fs.writeFile(resolvedFile, String(content), 'utf8');
      return Response.json({ success: true, path: resolvedFile, message: 'File saved successfully' });
    } catch (error) {
      if (isProjectBoundaryError(error)) return Response.json({ error: 'Path must be under project root' }, { status: 403 });
      if (hasNodeErrorCode(error, 'ENOENT')) return Response.json({ error: 'File or directory not found' }, { status: 404 });
      if (hasNodeErrorCode(error, 'EACCES')) return Response.json({ error: 'Permission denied' }, { status: 403 });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function handleContent(_request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      const filePath = url.searchParams.get('path');
      if (!filePath) return Response.json({ error: 'Invalid file path' }, { status: 400 });
      const resolvedFile = await resolveRealWithinBase(projectPath, filePath);
      await fs.access(resolvedFile);
      const mimeType = mime.lookup(resolvedFile) || 'application/octet-stream';
      const fileBuffer = await fs.readFile(resolvedFile);
      return new Response(fileBuffer, { headers: { 'Content-Type': mimeType } });
    } catch (error) {
      if (isProjectBoundaryError(error)) return Response.json({ error: 'Path must be under project root' }, { status: 403 });
      if (hasNodeErrorCode(error, 'ENOENT')) return Response.json({ error: 'File not found' }, { status: 404 });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  function mimeTypeForUpload(file: File): string {
    const declared = file.type.trim().toLowerCase();
    if (declared) return declared;
    const ext = path.extname(file.name).toLowerCase();
    return ATTACHMENT_MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
  }

  async function handleUploadAttachments(request: Request): Promise<Response> {
    try {
      const contentLength = Number.parseInt(request.headers.get('content-length') || '', 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_ATTACHMENT_UPLOAD_BODY_BYTES) {
        return Response.json({ error: 'Upload too large. Maximum request size is 30MB.' }, { status: 413 });
      }

      const formData = await request.formData();
      const entries = [
        ...formData.getAll('attachments'),
        ...formData.getAll('images'),
      ];
      const files = entries.filter((entry): entry is File => entry instanceof File);
      if (files.length === 0) return Response.json({ error: 'No files provided' }, { status: 400 });
      if (files.length > MAX_ATTACHMENT_COUNT) {
        return Response.json({ error: 'Maximum 5 files allowed' }, { status: 400 });
      }

      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
        return Response.json({ error: 'Total upload too large. Maximum combined size is 25MB.' }, { status: 413 });
      }

      const attachments = await Promise.all(files.map(async (file) => {
        const mimeType = mimeTypeForUpload(file);
        if (!ALLOWED_ATTACHMENT_MIMES.has(mimeType)) {
          throw new Error('Invalid file type. Only images, Markdown, text, and PDF files are allowed.');
        }
        if (file.size > MAX_ATTACHMENT_FILE_BYTES) {
          throw new Error('File too large. Maximum file size is 10MB.');
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        return {
          name: file.name,
          data: `data:${mimeType};base64,${buffer.toString('base64')}`,
          size: file.size,
          mimeType,
        };
      }));

      return Response.json({ attachments, images: attachments });
    } catch (error) {
      return Response.json({ error: errorMessage(error) || 'Internal server error' }, { status: 400 });
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
    '/api/v1/files/text': { GET: getText, PUT: withJsonBody(putText) },
    '/api/v1/files/content': { GET: handleContent },
    '/api/v1/files/upload-attachments': { POST: handleUploadAttachments },
    '/api/v1/files/upload-images': { POST: handleUploadAttachments },
    '/api/v1/files/browse': { GET: handleBrowse },
  };
}
