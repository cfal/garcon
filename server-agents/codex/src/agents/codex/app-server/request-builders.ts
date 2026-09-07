import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentAttachment } from '@garcon/common/agent-execution';
import type { PermissionMode, ThinkingMode } from '@garcon/common/chat-modes';
import { GPT_6_ASTRA_MODEL } from '@garcon/common/models';
import type { CodexProviderConfig, CodexStartRequest } from '../runtime-types.js';
import type { CodexSkillRef } from '../slash-command-discovery.js';
import type { ThreadInjectItemsParams } from './protocol.js';
import type {
  CodexThreadSettings,
  CodexThreadSettingsSandboxPolicy,
  ThreadSettingsUpdateParams,
} from './protocol.js';
import { attachmentMimeType, isImageAttachment, parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';

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

export interface CodexThreadSettingsTarget {
  readonly model: string;
  // Represents provider-owned Default as null because Codex reports the effective concrete effort.
  readonly effort: string | null;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly approvalsReviewer: 'user';
  readonly sandboxPolicy: CodexThreadSettingsSandboxPolicy;
  readonly permissionMode: PermissionMode;
}

export interface CodexConfirmedThreadSettings {
  readonly model: string;
  readonly effort: string | null;
  readonly approvalPolicy: unknown;
  readonly approvalsReviewer: string;
  readonly sandboxPolicy: CodexThreadSettingsSandboxPolicy;
  readonly permissionMode: PermissionMode;
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
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-matroska': '.mkv',
};

export function codexSandboxSettings(permissionMode: PermissionMode): CodexSandboxSettings {
  const effectivePermissionMode = permissionMode === 'plan' ? 'default' : permissionMode;
  return CODEX_SANDBOX[effectivePermissionMode] ?? CODEX_SANDBOX.default;
}

export function codexThreadSettingsTarget(configuration: {
  readonly model: string;
  readonly permissionMode: PermissionMode;
  readonly thinkingMode: ThinkingMode;
}): CodexThreadSettingsTarget {
  const { sandbox, approvalPolicy } = codexSandboxSettings(configuration.permissionMode);
  return {
    model: configuration.model,
    effort: mapThinkingModeToCodexEffort(configuration.thinkingMode, configuration.model) ?? null,
    approvalPolicy,
    approvalsReviewer: 'user',
    sandboxPolicy: sandbox === 'danger-full-access'
      ? { type: 'dangerFullAccess' }
      : {
          type: 'workspaceWrite',
          writableRoots: [],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
    permissionMode: configuration.permissionMode,
  };
}

export function buildThreadSettingsUpdateParams(
  threadId: string,
  target: CodexThreadSettingsTarget,
): ThreadSettingsUpdateParams {
  return {
    threadId,
    model: target.model,
    approvalPolicy: target.approvalPolicy,
    approvalsReviewer: target.approvalsReviewer,
    sandboxPolicy: target.sandboxPolicy,
    ...(target.effort !== null ? { effort: target.effort } : {}),
  };
}

export function threadSettingsMatch(
  settings: CodexConfirmedThreadSettings,
  target: CodexThreadSettingsTarget,
): boolean {
  // Accepts any confirmed effort when Codex owns the Default omitted from the update.
  return settings.model === target.model
    && (target.effort === null || settings.effort === target.effort)
    && settings.approvalPolicy === target.approvalPolicy
    && settings.approvalsReviewer === target.approvalsReviewer
    && sandboxPolicyMatches(settings.sandboxPolicy, target.sandboxPolicy);
}

export function threadSettingsTargetFromSnapshot(
  settings: CodexThreadSettings,
  currentPermissionMode: PermissionMode,
): CodexConfirmedThreadSettings {
  const permissionMode = permissionModeFromSettings(settings, currentPermissionMode);
  return {
    model: settings.model,
    effort: settings.effort,
    approvalPolicy: settings.approvalPolicy,
    approvalsReviewer: settings.approvalsReviewer,
    sandboxPolicy: normalizeSandboxPolicy(settings.sandboxPolicy),
    permissionMode,
  };
}

function permissionModeFromSettings(
  settings: CodexThreadSettings,
  current: PermissionMode,
): PermissionMode {
  if (settings.sandboxPolicy.type === 'dangerFullAccess') return 'bypassPermissions';
  if (settings.approvalPolicy === 'on-request') return 'manualBypass';
  return current === 'manualBypass' || current === 'bypassPermissions' ? 'default' : current;
}

function normalizeSandboxPolicy(
  sandboxPolicy: CodexThreadSettingsSandboxPolicy,
): CodexThreadSettingsSandboxPolicy {
  if (sandboxPolicy.type === 'dangerFullAccess') return { type: 'dangerFullAccess' };
  if (sandboxPolicy.type !== 'workspaceWrite') return sandboxPolicy;
  return {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: sandboxPolicy.networkAccess ?? false,
    excludeTmpdirEnvVar: sandboxPolicy.excludeTmpdirEnvVar ?? false,
    excludeSlashTmp: sandboxPolicy.excludeSlashTmp ?? false,
  };
}

function sandboxPolicyMatches(
  left: CodexThreadSettingsSandboxPolicy,
  right: CodexThreadSettingsSandboxPolicy,
): boolean {
  if (left.type !== right.type) return false;
  if (left.type !== 'workspaceWrite' || right.type !== 'workspaceWrite') return true;
  return (left.networkAccess ?? false) === (right.networkAccess ?? false)
    && (left.excludeTmpdirEnvVar ?? false) === (right.excludeTmpdirEnvVar ?? false)
    && (left.excludeSlashTmp ?? false) === (right.excludeSlashTmp ?? false);
}

// Preserves xhigh compatibility for older models while allowing models that
// advertise max reasoning to receive that effort explicitly.
export function mapThinkingModeToCodexEffort(
  thinkingMode: ThinkingMode | undefined,
  model?: string,
): string | undefined {
  switch (thinkingMode) {
    // Leaves provider defaults unset so Codex can honor config and model catalog defaults.
    case 'none': return undefined;
    case 'low': return 'low';
    case 'medium': return 'medium';
    case 'high': return 'high';
    case 'xhigh': return 'xhigh';
    case 'max': return model === GPT_6_ASTRA_MODEL
      || model === 'gpt-5.6'
      || model?.startsWith('gpt-5.6-')
      ? 'max'
      : 'xhigh';
    case 'ultra': return 'ultra';
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
  request: Pick<CodexStartRequest, 'model' | 'projectPath' | 'permissionMode' | 'codexConfig'>,
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

export function buildThreadStartParams(request: CodexStartRequest): Record<string, unknown> {
  return appendCommonThreadParams({
    ephemeral: false,
    historyMode: 'paginated',
  }, request);
}

export function buildInjectedContextItems(context: string): ThreadInjectItemsParams['items'] {
  // Keeps provider-owned context distinct from user turns while Codex persists it for later model requests.
  // https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/app-server/tests/suite/v2/thread_inject_items.rs#L27-L83
  return [{
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: context }],
  }];
}

export function buildThreadResumeParams(request: {
  agentSessionId: string;
  nativePath?: string | null;
} & Pick<CodexStartRequest, 'model' | 'projectPath' | 'permissionMode' | 'codexConfig'>): Record<string, unknown> {
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
  lastTurnId?: string | null;
}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    threadId: sourceSession.agentSessionId,
    cwd: sourceSession.projectPath,
    model: sourceSession.model ?? null,
    ephemeral: false,
    excludeTurns: true,
  };
  if (sourceSession.nativePath) params.path = sourceSession.nativePath;
  if (sourceSession.codexConfig?.config) params.config = sourceSession.codexConfig.config;
  if (sourceSession.lastTurnId) params.lastTurnId = sourceSession.lastTurnId;
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
  const effort = mapThinkingModeToCodexEffort(request.thinkingMode, request.model);
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

export async function writeAttachmentsToTempFiles(images?: readonly AgentAttachment[]): Promise<{
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

  try {
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
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    imagePaths,
    filePaths,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
