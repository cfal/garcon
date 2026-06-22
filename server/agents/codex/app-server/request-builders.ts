import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentCommandImage, CodexProviderConfig, PermissionMode, StartSessionRequest, ThinkingMode } from "../../session-types.js";

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexApprovalPolicy = 'never' | 'on-request';

interface CodexSandboxSettings {
  sandbox: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
}

const CODEX_SANDBOX: Record<string, CodexSandboxSettings> = {
  default: { sandbox: 'workspace-write', approvalPolicy: 'never' },
  acceptEdits: { sandbox: 'workspace-write', approvalPolicy: 'never' },
  manualBypass: { sandbox: 'workspace-write', approvalPolicy: 'never' },
  bypassPermissions: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
};

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export function codexSandboxSettings(permissionMode: PermissionMode): CodexSandboxSettings {
  const effectivePermissionMode = permissionMode === 'plan' ? 'default' : permissionMode;
  return CODEX_SANDBOX[effectivePermissionMode] ?? CODEX_SANDBOX.default;
}

export function mapThinkingModeToCodexEffort(thinkingMode: ThinkingMode | undefined): string {
  switch (thinkingMode) {
    case 'none': return 'low';
    case 'think': return 'low';
    case 'think-hard': return 'medium';
    case 'think-harder': return 'high';
    case 'ultrathink': return 'xhigh';
    default: return 'low';
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
  return appendCommonThreadParams({
    threadId: request.agentSessionId,
    excludeTurns: true,
  }, request);
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
  model: string;
  projectPath: string;
  permissionMode: PermissionMode;
  thinkingMode?: ThinkingMode;
}): Record<string, unknown> {
  const { approvalPolicy } = codexSandboxSettings(request.permissionMode);
  return {
    threadId: request.threadId,
    input: buildUserInput(request.command, request.imagePaths),
    cwd: request.projectPath,
    approvalPolicy,
    approvalsReviewer: 'user',
    model: request.model,
    effort: mapThinkingModeToCodexEffort(request.thinkingMode),
  };
}

export function buildUserInput(command: string, imagePaths?: string[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  if (command.trim()) {
    input.push({ type: 'text', text: command, text_elements: [] });
  }
  for (const imagePath of imagePaths ?? []) {
    input.push({ type: 'localImage', path: imagePath });
  }
  return input;
}

export async function writeImagesToTempFiles(images?: AgentCommandImage[]): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  if (!images?.length) {
    return { paths: [], cleanup: async () => {} };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-images-'));
  const paths: string[] = [];

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const match = img.data?.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) continue;

    const mimeType = match[1];
    const ext = MIME_EXTENSIONS[mimeType] || '.png';
    const filePath = path.join(tmpDir, `image-${i}${ext}`);
    await fs.writeFile(filePath, Buffer.from(match[2], 'base64'));
    paths.push(filePath);
  }

  return {
    paths,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
