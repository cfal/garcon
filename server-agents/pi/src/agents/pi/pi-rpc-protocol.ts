import type { AgentAttachment } from '@garcon/common/agent-execution';
import { parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import {
  AgentIntegrationError,
  type AgentSteerResult,
} from '@garcon/server-agent-interface';
import { buildPiPrompt } from './pi-cli.js';
import { PiRpcCommandError } from './pi-rpc-client.js';
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

export function piUserMessageText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const content = (value as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content.find((part) => (
    part
    && typeof part === 'object'
    && !Array.isArray(part)
    && (part as Record<string, unknown>).type === 'text'
    && typeof (part as Record<string, unknown>).text === 'string'
  )) as Record<string, unknown> | undefined;
  return typeof text?.text === 'string' ? text.text : null;
}

export function occurrenceCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

// Mirrors Pi's upward-first clamp for levels unsupported by the resolved model.
// https://github.com/earendil-works/pi-mono/blob/845d6ff1f6643aba440341cce877ce1c43ebbc39/packages/ai/src/models.ts#L661-L692
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
  // Defensive: Pi 0.84.2 accepts steers unconditionally, so no idle rejection exists today.
  if (/not (?:streaming|running)|no active turn/i.test(message)) {
    return rejectedPiSteer('no-active-turn', 'No active Pi turn');
  }
  return rejectedPiSteer('provider-rejected', 'Pi rejected the steering input');
}
