import { AttachmentValidationError, MAX_ATTACHMENT_UPLOAD_BODY_BYTES, uploadedAttachmentFromFile, validateAttachmentUploadBatch } from '../attachments/validation.js';
import { errorMessage } from './route-helpers.js';
import type { RouteMap } from '../lib/http-route-types.js';

const TOO_LARGE = 'Upload too large. Maximum request size is 30MB.';

async function readFormData(request: Request): Promise<FormData> {
  if (!request.body) return request.formData();
  let bytes = 0;
  const body = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_ATTACHMENT_UPLOAD_BODY_BYTES) throw new AttachmentValidationError(TOO_LARGE, 413);
      controller.enqueue(chunk);
    },
  }));
  const contentType = request.headers.get('content-type');
  return new Response(body, { headers: contentType ? { 'content-type': contentType } : undefined }).formData();
}

async function upload(request: Request): Promise<Response> {
  try {
    const length = Number.parseInt(request.headers.get('content-length') || '', 10);
    if (Number.isFinite(length) && length > MAX_ATTACHMENT_UPLOAD_BODY_BYTES) throw new AttachmentValidationError(TOO_LARGE, 413);
    const form = await readFormData(request);
    const files = [...form.getAll('attachments'), ...form.getAll('images')].filter((entry): entry is File => entry instanceof File);
    if (files.length === 0) return Response.json({ error: 'No files provided' }, { status: 400 });
    validateAttachmentUploadBatch(files);
    const attachments = await Promise.all(files.map(uploadedAttachmentFromFile));
    return Response.json({ attachments, images: attachments });
  } catch (error) {
    return Response.json({ error: errorMessage(error) || 'Internal server error' }, { status: error instanceof AttachmentValidationError ? error.status : 400 });
  }
}

export function createFileAttachmentRoutes(): RouteMap {
  return {
    '/api/v1/files/upload-attachments': { POST: upload },
    '/api/v1/files/upload-images': { POST: upload },
  };
}
