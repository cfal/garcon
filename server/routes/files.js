import { promises as fs } from 'fs';
import path from 'path';
import mime from 'mime-types';
import { parseJsonBody } from '../lib/http-request.js';
import { listDirectory, listDirectoryNames } from './projects.utils.js';
import { getProjectBasePath } from '../config.js';

const MAX_IMAGE_UPLOAD_BODY_BYTES = 30 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024;

// All directory validation and browsing is confined to this subtree.
const PROJECT_BASE_PATH = getProjectBasePath();

function isWithinBasePath(targetPath) {
  const resolved = path.resolve(targetPath);
  const projectBasePathPrefix = PROJECT_BASE_PATH.endsWith(path.sep) ? PROJECT_BASE_PATH : PROJECT_BASE_PATH + path.sep;
  return resolved === PROJECT_BASE_PATH || resolved.startsWith(projectBasePathPrefix);
}

async function listAllFiles(dirPath, maxDepth = 10, currentDepth = 0) {
  const skipNames = new Set(['node_modules', 'dist', 'build', '.git', '.svn', '.hg']);
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const results = [];
  for (const entry of entries) {
    if (skipNames.has(entry.name)) continue;
    const itemPath = path.join(dirPath, entry.name);
    const isDir = entry.isDirectory();
    results.push({ name: entry.name, path: itemPath, type: isDir ? 'directory' : 'file' });
    if (isDir && currentDepth < maxDepth) {
      const children = await listAllFiles(itemPath, maxDepth, currentDepth + 1);
      results.push(...children);
    }
  }
  return results;
}

function resolvePathWithinProject(projectRoot, inputPath) {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(resolvedRoot, inputPath);
  const normalizedRoot = `${resolvedRoot}${path.sep}`;
  if (!resolvedPath.startsWith(normalizedRoot) && resolvedPath !== resolvedRoot) {
    return null;
  }
  return resolvedPath;
}

export default function createFilesRoutes(registry) {

  // Resolves the project path from either a chatId or projectPath query param.
  async function resolveProjectPath(url) {
    const chatId = url.searchParams.get('chatId');
    if (chatId) {
      const chat = registry.getChat(chatId);
      if (!chat?.projectPath) {
        return { error: Response.json({ error: 'Chat not found or missing projectPath' }, { status: 404 }) };
      }
      return { projectPath: chat.projectPath };
    }

    const projectPath = url.searchParams.get('projectPath');
    if (!projectPath) {
      return { error: Response.json({ error: 'chatId or projectPath is required' }, { status: 400 }) };
    }
    return { projectPath };
  }

  async function handleTree(request, url) {
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
        const resolvedTarget = resolvePathWithinProject(projectPath, requestedPath);
        if (!resolvedTarget) {
          return Response.json({ error: 'Path must be under project root' }, { status: 403 });
        }
        targetDir = resolvedTarget;
      }
      const files = await listDirectory(targetDir, true);
      return Response.json(files);
    } catch (error) {
      console.error('files: file tree error:', error.message);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function handleList(request, url) {
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
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function getText(request, url) {
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
      const resolvedFile = resolvePathWithinProject(projectPath, filePath);
      if (!resolvedFile) return Response.json({ error: 'Path must be under project root' }, { status: 403 });
      const content = await fs.readFile(resolvedFile, 'utf8');
      return Response.json({ content, path: resolvedFile });
    } catch (error) {
      if (error.code === 'ENOENT') return Response.json({ error: 'File not found' }, { status: 404 });
      if (error.code === 'EACCES') return Response.json({ error: 'Permission denied' }, { status: 403 });
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function putText(request, url) {
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
      const { content } = await parseJsonBody(request);
      if (!filePath) return Response.json({ error: 'Invalid file path' }, { status: 400 });
      if (content === undefined) return Response.json({ error: 'Content is required' }, { status: 400 });
      const resolvedFile = resolvePathWithinProject(projectPath, filePath);
      if (!resolvedFile) return Response.json({ error: 'Path must be under project root' }, { status: 403 });
      await fs.writeFile(resolvedFile, content, 'utf8');
      return Response.json({ success: true, path: resolvedFile, message: 'File saved successfully' });
    } catch (error) {
      if (error.message === 'Malformed JSON') {
        return Response.json({ error: 'Malformed JSON' }, { status: 400 });
      }
      if (error.code === 'ENOENT') return Response.json({ error: 'File or directory not found' }, { status: 404 });
      if (error.code === 'EACCES') return Response.json({ error: 'Permission denied' }, { status: 403 });
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function handleContent(request, url) {
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
      const resolvedFile = resolvePathWithinProject(projectPath, filePath);
      if (!resolvedFile) return Response.json({ error: 'Path must be under project root' }, { status: 403 });
      await fs.access(resolvedFile);
      const mimeType = mime.lookup(resolvedFile) || 'application/octet-stream';
      const fileBuffer = await fs.readFile(resolvedFile);
      return new Response(fileBuffer, { headers: { 'Content-Type': mimeType } });
    } catch (error) {
      if (error.code === 'ENOENT') return Response.json({ error: 'File not found' }, { status: 404 });
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  async function handleUploadImages(request, url) {
    const resolved = await resolveProjectPath(url);
    if (resolved.error) return resolved.error;

    try {
      const contentLength = Number.parseInt(request.headers.get('content-length') || '', 10);
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_UPLOAD_BODY_BYTES) {
        return Response.json({ error: 'Upload too large. Maximum request size is 30MB.' }, { status: 413 });
      }

      const allowedMimes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']);
      const formData = await request.formData();
      const files = formData.getAll('images').filter((entry) => entry instanceof File);
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
      return Response.json({ error: error.message || 'Internal server error' }, { status: 400 });
    }
  }

  async function handleBrowse(request, url) {
    const dirPath = url.searchParams.get('path') || PROJECT_BASE_PATH;

    if (!isWithinBasePath(dirPath)) {
      return Response.json([]);
    }

    try {
      await fs.access(dirPath);
    } catch {
      return Response.json([]);
    }

    try {
      const entries = await listDirectoryNames(dirPath, true);
      return Response.json(
        entries.filter((e) => e.type === 'directory' && isWithinBasePath(e.path))
      );
    } catch {
      return Response.json([]);
    }
  }

  return {
    '/api/v1/files/tree': { GET: handleTree },
    '/api/v1/files/list': { GET: handleList },
    '/api/v1/files/text': { GET: getText, PUT: putText },
    '/api/v1/files/content': { GET: handleContent },
    '/api/v1/files/upload-images': { POST: handleUploadImages },
    '/api/v1/files/browse': { GET: handleBrowse },
  };
}
