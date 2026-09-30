import type { AgentAttachment } from '@garcon/common/agent-execution';
import { CompactionMessage } from '@garcon/common/chat-types';
import { isRecord } from '@garcon/common/json';
import { parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import type { RpcResponse } from '@earendil-works/pi-coding-agent';
import {
  AgentIntegrationError,
  type AgentSteerResult,
} from '@garcon/server-agent-interface';
import { buildPiPrompt } from './pi-cli.js';
import { PiRpcCommandError, PiRpcTransportError, type PiRpcResponse } from './pi-rpc-client.js';
import type { PiResumeRequest, PiStartRequest } from './runtime-types.js';

const PI_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

type PiInputDisposition = Extract<RpcResponse, { command: 'prompt'; success: true }>['data']['disposition'];

export function piInputDisposition(response: PiRpcResponse, command: 'prompt' | 'steer'): PiInputDisposition {
  const disposition = response.data?.disposition;
  if (response.command === command) {
    switch (disposition) {
      case 'handled':
      case 'queued':
        return disposition;
      case 'started':
        if (command === 'prompt') return disposition;
    }
  }
  throw new PiRpcTransportError(`Pi returned an invalid ${command} disposition`, true);
}

export interface PreparedPiRpcPrompt {
  readonly message: string;
  readonly images: Array<{ type: 'image'; data: string; mimeType: string }>;
}

export function preparePiRpcPrompt(
  request: PiStartRequest | PiResumeRequest,
): PreparedPiRpcPrompt {
  const images = rpcImages(request.images);
  return {
    message: buildPiPrompt(request.command, request.permissionMode, images.length > 0),
    images,
  };
}

function rpcImages(
  attachments: readonly AgentAttachment[] | undefined,
): Array<{ type: 'image'; data: string; mimeType: string }> {
  const images: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const attachment of attachments ?? []) {
    const parts = parseAttachmentDataUrl(attachment.data);
    const mimeType = parts?.mimeType ?? attachment.mimeType;
    if (!parts || !mimeType.startsWith('image/')) {
      throw new AgentIntegrationError(
        'PROVIDER_FAILURE',
        `Pi cannot attach ${attachment.name ?? 'an attachment'}: only base64 image data URLs are supported`,
        false,
      );
    }
    images.push({ type: 'image', data: parts.base64, mimeType });
  }
  return images;
}

export function piCompactionMessage(
  event: Record<string, unknown>,
  timestamp: string,
): CompactionMessage | null {
  if (event.type !== 'compaction_end' || event.aborted !== false) return null;
  if (!isRecord(event.result)) return null;
  const { summary, tokensBefore, estimatedTokensAfter } = event.result;
  if (typeof summary !== 'string' || !isPiTokenCount(tokensBefore)) return null;
  if (estimatedTokensAfter !== undefined && !isPiTokenCount(estimatedTokensAfter)) return null;
  const reason = event.reason;
  if (reason !== 'manual' && reason !== 'threshold' && reason !== 'overflow') return null;
  return new CompactionMessage(
    timestamp,
    reason === 'manual' ? 'manual' : 'auto',
    summary,
    tokensBefore,
    estimatedTokensAfter,
  );
}

function isPiTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Mirrors Pi's upward-first clamp for levels unsupported by the resolved model.
// https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/ai/src/models.ts#L913-L945
export function resolvePiThinkingLevel(
  model: Readonly<Record<string, unknown>>,
  requested: ModelThinkingLevel,
): ModelThinkingLevel {
  const levelMap = model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object'
    ? model.thinkingLevelMap as Readonly<Record<string, unknown>>
    : null;
  const supported = model.reasoning === true
    ? PI_THINKING_LEVELS.filter((level) => {
      const mapped = levelMap?.[level];
      if (mapped === null) return false;
      return (level !== 'xhigh' && level !== 'max') || mapped !== undefined;
    })
    : ['off'] satisfies ModelThinkingLevel[];
  if (supported.includes(requested)) return requested;

  const requestedIndex = PI_THINKING_LEVELS.indexOf(requested);
  for (let index = requestedIndex; index < PI_THINKING_LEVELS.length; index += 1) {
    const candidate = PI_THINKING_LEVELS[index];
    if (supported.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = PI_THINKING_LEVELS[index];
    if (supported.includes(candidate)) return candidate;
  }
  return supported[0] ?? 'off';
}

export function rejectedPiSteer(
  reason: Extract<AgentSteerResult, { kind: 'rejected' }>['reason'],
  message: string,
): AgentSteerResult {
  return { kind: 'rejected', reason, message };
}

export function classifyPiSteerRejection(error: PiRpcCommandError): AgentSteerResult {
  const message = error.message;
  if (/extension command|cannot be queued/i.test(message)) {
    return rejectedPiSteer('invalid-input', 'Pi rejected the steering input');
  }
  // Pi can enqueue while idle; this is defensive, not proof of target-turn delivery.
  if (/not (?:streaming|running)|no active turn/i.test(message)) {
    return rejectedPiSteer('no-active-turn', 'No active Pi turn');
  }
  return rejectedPiSteer('provider-rejected', 'Pi rejected the steering input');
}
