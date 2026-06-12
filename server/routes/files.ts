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
  projectBoundaryErrorResponse,
  resolveRealWithinBase,
} from '../lib/path-boundary.ts';
import type { RouteMap } from '../lib/http-route-types.js';
import type { IChatRegistry } from '../chats/store.js';
import { asJsonBody, errorMessage, type JsonBody } from './route-helpers.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('routes:files');

const MAX_IMAGE_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024;

interface FileListItem {
  name: string;
  path: string;
  relativePath: string;
  type: 'file';
}

type ProjectPathResolution =
  | { projectPath: string; error?: undefined }
  | { error: Response; projectPath?: undefined };

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
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

  // Resolves the project path from either a chatId or projectPath query param.
  async function resolveProjectPath(url: URL): Promise<ProjectPathResolution> {
    const chatId = url.searchParams.get('chatId');
    if (chatId) {
      const chat = registry.getChat(chatId);
      if (!chat?.projectPath) {
        return { error: Response.json({ error: 'Chat not found or missing projectPath' }, { status: 404 }) };
      }
      try {
        return { projectPath: await assertRealWithinProjectBase(chat.projectPath) };
      } catch (error) {
        if (isProjectBoundaryError(error)) return { error: projectBoundaryErrorResponse() };
        throw error;
      }
    }

    const projectPath = url.searchParams.get('projectPath');
    if (!projectPath) {
      return { error: Response.json({ error: 'chatId or projectPath is required' }, { status: 400 }) };
    }
    try {
      return { projectPath: await assertRealWithinProjectBase(projectPath) };
    } catch (error) {
      if (isProjectBoundaryError(error)) return { error: projectBoundaryErrorResponse() };
      throw error;
    }
  }

  async function handleTree(_request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      await fs.access(projectPath);
    } catch {
      return Response.json({ error: `Project path not found: ${projectPath}` }, { status: 404 });
    }

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
      await fs.access(projectPath);
    } catch {
      return Response.json({ error: `Project path not found: ${projectPath}` }, { status: 404 });
    }

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
      await fs.access(projectPath);
    } catch {
      return Response.json({ error: `Project path not found: ${projectPath}` }, { status: 404 });
    }

    try {
      const filePath = url.searchParams.get('path');
      if (!filePath) return Response.json({ error: 'Invalid file path' }, { status: 400 });
      const resolvedFile = await resolveRealWithinBase(projectPath, filePath);
      const content = await fs.readFile(resolvedFile, 'utf8');
      return Response.json({ content, path: resolvedFile });
    } catch (error) {
      if (isProjectBoundaryError(error)) return Response.json({ error: 'Path must be under project root' }, { status: 403 });
      if (isErrnoException(error) && error.code === 'ENOENT') return Response.json({ error: 'File not found' }, { status: 404 });
      if (isErrnoException(error) && error.code === 'EACCES') return Response.json({ error: 'Permission denied' }, { status: 403 });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function putText(body: JsonBody, _request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      await fs.access(projectPath);
    } catch {
      return Response.json({ error: `Project path not found: ${projectPath}` }, { status: 404 });
    }

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
      if (isErrnoException(error) && error.code === 'ENOENT') return Response.json({ error: 'File or directory not found' }, { status: 404 });
      if (isErrnoException(error) && error.code === 'EACCES') return Response.json({ error: 'Permission denied' }, { status: 403 });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function handleContent(_request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;
    const { projectPath } = resolved;

    try {
      await fs.access(projectPath);
    } catch {
      return Response.json({ error: `Project path not found: ${projectPath}` }, { status: 404 });
    }

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
      if (isErrnoException(error) && error.code === 'ENOENT') return Response.json({ error: 'File not found' }, { status: 404 });
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function handleUploadImages(request: Request, url: URL): Promise<Response> {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;

    try {
      const contentLength = Number.parseInt(request.headers.get('content-length') || '', 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_UPLOAD_BODY_BYTES) {
        return Response.json({ error: 'Upload too large. Maximum request size is 30MB.' }, { status: 413 });
      }

      const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']);
      const formData = await request.formData();
      const files = formData.getAll('images').filter((entry): entry is File => entry instanceof File);
      if (files.length === 0) return Response.json({ error: 'No image files provided' }, { status: 400 });
      if (files.length > 5) return Response.json({ error: 'Maximum 5 images allowed' }, { status: 400 });

      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > MAX_IMAGE_TOTAL_BYTES) {
        return Response.json({ error: 'Total upload too large. Maximum combined size is 25MB.' }, { status: 413 });
      }

      const processedImages = await Promise.all(files.map(async (file) => {
        if (!allowedMimes.has(file.type)) {
          throw new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.');
        }
        if (file.size > 5 * 1024 * 1024) {
          throw new Error('File too large. Maximum file size is 5MB.');
        }
        const buffer = Buffer.from(await file.arrayBuffer());
        return {
          name: file.name,
          data: `data:${file.type};base64,${buffer.toString('base64')}`,
          size: file.size,
          mimeType: file.type,
        };
      }));

      return Response.json({ images: processedImages });
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
    '/api/v1/files/upload-images': { POST: handleUploadImages },
    '/api/v1/files/browse': { GET: handleBrowse },
  };
}
