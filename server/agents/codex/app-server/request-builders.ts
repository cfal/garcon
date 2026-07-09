import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentCommandImage, CodexProviderConfig, PermissionMode, StartSessionRequest, ThinkingMode } from "../../session-types.js";
import type { CodexSkillRef } from '../slash-command-discovery.js';
import { attachmentMimeType, isImageAttachment, parseAttachmentDataUrl } from '../../shared/attachments.js';

// Matches a leading "/<name>" skill token with optional trailing arguments,
// mirroring the composer's slash-command trigger.
const LEADING_SLASH_RE = /^\/([a-zA-Z0-9:_-]+)(?:\s+([\s\S]*))?$/;

// Parses a leading "/<name> args" token from a turn command, if present.
export function parseLeadingSlashCommand(command: string): { name: string; rest: string } | null {
  const match = LEADING_SLASH_RE.exec(command);
  if (!match) return null;
  return { name: match[1], rest: match[2] ?? '' };
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'never' | 'on-request';

interface CodexSandboxSettings {
  sandbox: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
}

const CODEX_SANDBOX: Record<string, CodexSandboxSettings> = {
  default: { sandbox: 'workspace-write', approvalPolicy: 'never' },
  acceptEdits: { sandbox: 'workspace-write', approvalPolicy: 'never' },
  manualBypass: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  bypassPermissions: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
};

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/markdown': '.md',
  'text/plain': '.txt',
};

export function codexSandboxSettings(permissionMode: PermissionMode): CodexSandboxSettings {
  const effectivePermissionMode = permissionMode === 'plan' ? 'default' : permissionMode;
  return CODEX_SANDBOX[effectivePermissionMode] ?? CODEX_SANDBOX.default;
}

// Omits the field for Garcon's "Default" mode so Codex can use its own
// model/config default instead of receiving an explicit low-effort override.
// Codex's native model catalog currently exposes xhigh as its highest effort.
export function mapThinkingModeToCodexEffort(thinkingMode: ThinkingMode | undefined): string | undefined {
  switch (thinkingMode) {
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': return 'xhigh';
    default: return undefined;
  }
}

export function buildCodexEnv(
  envOverrides?: Record<string, string>,
  codexConfig?: CodexProviderConfig,
): Record<string, string> | undefined {
  const env = {
    ...(envOverrides ?? {}),
    ...(codexConfig?.env ?? {}),
  };
  return Object.keys(env).length > 0 ? env : undefined;
}

function appendCommonThreadParams(
  params: Record<string, unknown>,
  request: Pick<StartSessionRequest, 'model' | 'projectPath' | 'permissionMode' | 'codexConfig'>,
): Record<string, unknown> {
  const { sandbox, approvalPolicy } = codexSandboxSettings(request.permissionMode);
  params.model = request.model;
  params.cwd = request.projectPath;
  params.sandbox = sandbox;
  params.approvalPolicy = approvalPolicy;
  params.approvalsReviewer = 'user';
  if (request.codexConfig?.config) params.config = request.codexConfig.config;
  return params;
}

export function buildThreadStartParams(request: StartSessionRequest): Record<string, unknown> {
  return appendCommonThreadParams({
    ephemeral: false,
  }, request);
}

export function buildThreadResumeParams(request: {
  agentSessionId: string;
  nativePath?: string | null;
} & Pick<StartSessionRequest, 'model' | 'projectPath' | 'permissionMode' | 'codexConfig'>): Record<string, unknown> {
  const params = appendCommonThreadParams({
    threadId: request.agentSessionId,
    excludeTurns: true,
  }, request);
  if (request.nativePath) params.path = request.nativePath;
  return params;
}

export function buildThreadForkParams(sourceSession: {
  agentSessionId: string;
  nativePath?: string | null;
  model?: string | null;
  projectPath: string;
  codexConfig?: CodexProviderConfig;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    threadId: sourceSession.agentSessionId,
    cwd: sourceSession.projectPath,
    model: sourceSession.model ?? null,
    ephemeral: false,
    excludeTurns: true,
  };
  if (sourceSession.codexConfig?.config) params.config = sourceSession.codexConfig.config;
  return params;
}

export function buildTurnStartParams(request: {
  threadId: string;
  command: string;
  imagePaths?: string[];
  filePaths?: string[];
  model: string;
  projectPath: string;
  permissionMode: PermissionMode;
  thinkingMode?: ThinkingMode;
  clientMessageId?: string;
  skills?: CodexSkillRef[];
}): Record<string, unknown> {
  const { approvalPolicy } = codexSandboxSettings(request.permissionMode);
  const params: Record<string, unknown> = {
    threadId: request.threadId,
    input: buildUserInput(commandWithAttachmentPaths(request.command, request.filePaths), request.imagePaths, request.skills),
    cwd: request.projectPath,
    approvalPolicy,
    approvalsReviewer: 'user',
    model: request.model,
  };
  if (request.clientMessageId) params.clientUserMessageId = request.clientMessageId;
  const effort = mapThinkingModeToCodexEffort(request.thinkingMode);
  if (effort) params.effort = effort;
  return params;
}

function commandWithAttachmentPaths(command: string, filePaths?: string[]): string {
  if (!filePaths?.length) return command;
  const attachmentList = filePaths.map((filePath) => `- ${filePath}`).join('\n');
  return [
    command,
    'Attached files are available on disk:',
    attachmentList,
  ].filter((part) => part.trim()).join('\n\n');
}

export function goalObjectiveWithAttachmentPaths(
  objective: string,
  imagePaths: string[] = [],
  filePaths: string[] = [],
): string {
  const references = [
    ...imagePaths.map((filePath) => `- Image: ${filePath}`),
    ...filePaths.map((filePath) => `- File: ${filePath}`),
  ];
  if (!references.length) return objective;
  return [objective, 'Attached inputs are available on disk:', references.join('\n')].join('\n\n');
}

// Builds the Codex turn input. When the command opens with "/<name>" and that
// name matches an available skill, emits a `skill` input item (so Codex invokes
// the skill) plus any trailing text; otherwise sends the command as plain text.
export function buildUserInput(
  command: string,
  imagePaths?: string[],
  skills?: CodexSkillRef[],
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];

  const parsed = skills?.length ? parseLeadingSlashCommand(command) : null;
  const skill = parsed ? skills!.find((candidate) => candidate.name === parsed.name) : null;

  if (skill && parsed) {
    input.push({ type: 'skill', name: skill.name, path: skill.path });
    if (parsed.rest.trim()) {
      input.push({ type: 'text', text: parsed.rest, text_elements: [] });
    }
  } else if (command.trim()) {
    input.push({ type: 'text', text: command, text_elements: [] });
  }

  for (const imagePath of imagePaths ?? []) {
    input.push({ type: 'localImage', path: imagePath });
  }
  return input;
}

export async function writeAttachmentsToTempFiles(images?: AgentCommandImage[]): Promise<{
  imagePaths: string[];
  filePaths: string[];
  cleanup: () => Promise<void>;
}> {
  if (!images?.length) {
    return { imagePaths: [], filePaths: [], cleanup: async () => {} };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-attachments-'));
  const imagePaths: string[] = [];
  const filePaths: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const attachment = images[i];
    const parts = parseAttachmentDataUrl(attachment.data);
    if (!parts) continue;

    const mimeType = attachmentMimeType(attachment);
    const ext = MIME_EXTENSIONS[mimeType];
    if (!ext) continue;
    const prefix = isImageAttachment(attachment) ? 'image' : 'attachment';
    const filePath = path.join(tmpDir, `${prefix}-${i}${ext}`);
    await fs.writeFile(filePath, Buffer.from(parts.base64, 'base64'));
    if (isImageAttachment(attachment)) imagePaths.push(filePath);
    else filePaths.push(filePath);
  }

  return {
    imagePaths,
    filePaths,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
