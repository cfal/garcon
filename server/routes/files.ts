import { withJsonBody } from '../lib/json-route.js';
import { isProjectBoundaryError, projectBoundaryErrorResponse } from '../lib/path-boundary.js';
import { selectProjectPathFromUrl, projectUnavailableResponse } from './project-path-resolver.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { IChatRegistry } from '../chats/store.js';
import { asJsonBody, errorMessage, type JsonBody } from './route-helpers.js';
import { createLogger } from '../lib/log.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { jsonError, jsonErrorFromUnknown } from '../lib/http-error.js';
import { isDomainError, ProjectUnavailableError, ValidationDomainError } from '../lib/domain-error.js';
import { FilePathMustIdentifyFileError } from '../files/file-revision.js';
import {
  FileRevisionConflictError,
  FileTreeDirectoryRequiredError,
  type WorkspaceFileService,
} from '../execution-nodes/workspace-files.js';
import {
  AttachmentValidationError,
  MAX_ATTACHMENT_UPLOAD_BODY_BYTES,
  uploadedAttachmentFromFile,
  validateAttachmentUploadBatch,
} from '../attachments/validation.js';
import { FILE_REVISION_HEADER, parseSaveTextRequest } from '../../common/file-contracts.js';

const logger = createLogger('routes:files');

const ATTACHMENT_UPLOAD_TOO_LARGE_MESSAGE = 'Upload too large. Maximum request size is 30MB.';
const CLIENT_CLOSED_REQUEST_STATUS = 499;

async function readAttachmentFormData(request: Request): Promise<FormData> {
  if (!request.body) return request.formData();
  let totalBytes = 0;
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_ATTACHMENT_UPLOAD_BODY_BYTES) {
        throw new AttachmentValidationError(ATTACHMENT_UPLOAD_TOO_LARGE_MESSAGE, 413);
      }
      controller.enqueue(chunk);
    },
  }));

  const contentType = request.headers.get('content-type');
  return new Response(body, {
    headers: contentType ? { 'content-type': contentType } : undefined,
  }).formData();
}

function fileRevisionConflictResponse(): Response {
  return jsonError(
    'File changed on disk',
    409,
    'FILE_REVISION_CONFLICT',
    false,
  );
}

function unexpectedFileOperationError(
  operation: string,
  error: unknown,
  request: Request,
): Response {
  const cancelled = cancelledFileRequestResponse(request, error);
  if (cancelled) return cancelled;
  if (error instanceof ProjectUnavailableError) return projectUnavailableResponse(error.projectPath, error.reason);
  if (!isDomainError(error)) {
    logger.error(`files: ${operation} error:`, errorMessage(error));
  }
  return jsonErrorFromUnknown(error);
}

function cancelledFileRequestResponse(request: Request, error: unknown): Response | null {
  if (request.signal.aborted && (
    error === request.signal.reason || (error instanceof Error && error.name === 'AbortError')
  )) {
    return new Response(null, { status: CLIENT_CLOSED_REQUEST_STATUS });
  }
  return null;
}

export default function createFilesRoutes(
  registry: IChatRegistry,
  files: WorkspaceFileService,
): RouteMap {
  const selectProject = (url: URL) => selectProjectPathFromUrl(registry, url);

  async function handleBaseTree(
    request: Request,
    url: URL,
  ): Promise<Response> {
    try {
      return Response.json(await files.tree(url.searchParams.get('path'), request.signal));
    } catch (error) {
      if (error instanceof FileTreeDirectoryRequiredError) {
        return jsonError(error.message, 400, 'FILE_TREE_DIRECTORY_REQUIRED', false);
      }
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
      return unexpectedFileOperationError('file tree', error, request);
    }
  }

  async function handleList(request: Request, url: URL): Promise<Response> {
    const selected = selectProject(url);
    if (selected.error) return selected.error;
    try {
      const { files: listed, truncated } = await files.list(selected.projectPath, request.signal);
      return Response.json(listed, {
        headers: truncated ? { 'X-Garcon-File-List-Truncated': 'true' } : undefined,
      });
    } catch (error) {
      const cancelled = cancelledFileRequestResponse(request, error);
      if (cancelled) return cancelled;
      if (error instanceof ProjectUnavailableError) return projectUnavailableResponse(error.projectPath, error.reason);
      return Response.json({ error: errorMessage(error) }, { status: 500 });
    }
  }

  async function handleIdentity(request: Request, url: URL): Promise<Response> {
    const selected = selectProject(url);
    if (selected.error) return selected.error;
    try {
      return Response.json(await files.identity({
        projectPath: selected.projectPath, filePath: url.searchParams.get('path') || '',
      }, request.signal));
    } catch (error) {
      const cancelled = cancelledFileRequestResponse(request, error);
      if (cancelled) return cancelled;
      if (error instanceof ProjectUnavailableError) return projectUnavailableResponse(error.projectPath, error.reason);
      if (error instanceof ValidationDomainError || error instanceof FilePathMustIdentifyFileError) {
        return Response.json({ error: error.message }, { status: 400 });
      }
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

  async function getText(request: Request, url: URL): Promise<Response> {
    const selected = selectProject(url);
    if (selected.error) return selected.error;
    try {
      const filePath = url.searchParams.get('path');
      if (!filePath) return Response.json({ error: 'Invalid file path' }, { status: 400 });
      return Response.json(await files.readText({ projectPath: selected.projectPath, filePath }, request.signal));
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
      return unexpectedFileOperationError('text read', error, request);
    }
  }

  async function handleRevision(request: Request, url: URL): Promise<Response> {
    const selected = selectProject(url);
    if (selected.error) return selected.error;
    try {
      const filePath = url.searchParams.get('path');
      if (!filePath) return jsonError('Invalid file path', 400, 'VALIDATION_FAILED', false);
      return Response.json(await files.revision({ projectPath: selected.projectPath, filePath }, request.signal));
    } catch (error) {
      if (isProjectBoundaryError(error)) return projectBoundaryErrorResponse();
      if (
        hasNodeErrorCode(error, 'EACCES') ||
        hasNodeErrorCode(error, 'EPERM')
      ) {
        return jsonError(
          'Permission denied',
          403,
          'FILE_PERMISSION_DENIED',
          false,
        );
      }
      return unexpectedFileOperationError('revision check', error, request);
    }
  }

  async function putText(body: JsonBody, request: Request, url: URL): Promise<Response> {
    const selected = selectProject(url);
    if (selected.error) return selected.error;
    try {
      const filePath = url.searchParams.get('path');
      if (!filePath) return jsonError('Invalid file path', 400, 'VALIDATION_FAILED', false);
      const saveRequest = parseSaveTextRequest(asJsonBody(body));
      if (!saveRequest) {
        return jsonError('Content, expectedRevision, and conflictResolution are required', 400, 'VALIDATION_FAILED', false);
      }
      return Response.json(await files.saveText({ projectPath: selected.projectPath, filePath }, saveRequest, request.signal));
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
      if (error instanceof FileRevisionConflictError) {
        return fileRevisionConflictResponse();
      }
      return unexpectedFileOperationError('text save', error, request);
    }
  }

  async function handleContent(request: Request, url: URL): Promise<Response> {
    const selected = selectProject(url);
    if (selected.error) return selected.error;
    try {
      const filePath = url.searchParams.get('path');
      if (!filePath) return Response.json({ error: 'Invalid file path' }, { status: 400 });
      const { bytes, mimeType, revision } = await files.content({ projectPath: selected.projectPath, filePath }, request.signal);
      return new Response(bytes, { headers: { 'Content-Type': mimeType, [FILE_REVISION_HEADER]: revision } });
    } catch (error) {
      if (isProjectBoundaryError(error))
        return Response.json(
          { error: 'Path must be under project root' },
          { status: 403 },
        );
      if (hasNodeErrorCode(error, 'ENOENT'))
        return Response.json({ error: 'File not found' }, { status: 404 });
      return unexpectedFileOperationError('content read', error, request);
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
        throw new AttachmentValidationError(ATTACHMENT_UPLOAD_TOO_LARGE_MESSAGE, 413);
      }

      const formData = await readAttachmentFormData(request);
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

  async function handleBrowse(request: Request, url: URL): Promise<Response> {
    try {
      return Response.json(await files.browse(url.searchParams.get('path'), request.signal));
    } catch (error) {
      return unexpectedFileOperationError('directory browse', error, request);
    }
  }

  return {
    '/api/v1/files/tree': { GET: handleBaseTree },
    '/api/v1/files/list': { GET: handleList },
    '/api/v1/files/identity': { GET: handleIdentity },
    '/api/v1/files/revision': { GET: handleRevision },
    '/api/v1/files/text': { GET: getText, PUT: withJsonBody(putText) },
    '/api/v1/files/content': { GET: handleContent },
    '/api/v1/files/upload-attachments': { POST: handleUploadAttachments },
    '/api/v1/files/upload-images': { POST: handleUploadAttachments },
    '/api/v1/files/browse': { GET: handleBrowse },
  };
}
