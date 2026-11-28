import {
  appendTextAttachmentContext, attachmentDocumentBlock, fitsInlineTextAttachment,
  parseAttachmentDataUrl, type AttachmentInput,
} from "../../../../server-agents/common/src/shared/attachments.ts";
import { classifyDirectIntegrationError } from "../../../../server-agents/common/src/direct/errors.ts";
import { resolveDirectExplicitEffort } from "../../../../server-agents/common/src/direct/reasoning-effort.ts";
import { isJsonResponse } from "../../../../server-agents/common/src/direct/response-media-type.ts";
import { directEndpointFingerprint } from "../../../../server-agents/common/src/direct/router.ts";
import { directSingleQueryTimeoutMs } from "../../../../server-agents/common/src/direct/single-query-options.ts";
import { stripThinkBlocks } from "../../../../server-agents/common/src/direct/strip-think-blocks.ts";
import type { DirectEndpointRuntime } from "../../../../server-agents/common/src/direct/runtime-types.ts";

export const stripReasoning = (text: string) => stripThinkBlocks(text);
export const explicitEffort = (input: unknown) => resolveDirectExplicitEffort(input);
export const queryTimeout = (options: { timeoutMs?: number }) => directSingleQueryTimeoutMs(options);
export const routeFingerprint = (endpoint: DirectEndpointRuntime) => directEndpointFingerprint(endpoint);
export const attachmentData = (url: string) => parseAttachmentDataUrl(url);
export const inlineAttachment = (attachment: AttachmentInput) => fitsInlineTextAttachment(attachment);
export const attachmentDocument = (attachment: AttachmentInput) => attachmentDocumentBlock(attachment);
export const attachmentContext = (text: string, attachments: AttachmentInput[]) => appendTextAttachmentContext(text, attachments);
export const jsonMediaType = (header: string | null) => isJsonResponse(new Response(null, {
  headers: header === null ? undefined : { "content-type": header },
}));
export const classifyFailure = (message: string) => {
  const error = classifyDirectIntegrationError(new Error(message));
  return { code: error.code, message: error.message, retryable: error.retryable };
};
