import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import type { AgentAttachment } from '@garcon/common/agent-execution';
import { attachmentMimeType, isImageAttachment, parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';

const MAX_GOAL_OBJECTIVE_CHARS = 4_000;
const GOAL_ATTACHMENT_DIR = 'attachments';
const GOAL_ATTACHMENT_OWNER_FILE = '.garcon-owner.json';
const GOAL_OBJECTIVE_FILE = 'goal-objective.md';
const GOAL_ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

export interface MaterializedGoalDraft {
  objective: string;
  outputDir: string | null;
}

export async function materializeGoalDraft(
  codexHome: string | null,
  threadId: string,
  objective: string,
  attachments: readonly AgentAttachment[] | undefined,
): Promise<MaterializedGoalDraft> {
  let outputDir: string | null = null;
  try {
    const imageLines: string[] = [];
    const fileLines: string[] = [];
    let imageIndex = 0;
    let fileIndex = 0;
    for (const attachment of attachments ?? []) {
      const parts = parseAttachmentDataUrl(attachment.data);
      const extension = MIME_EXTENSIONS[attachmentMimeType(attachment)];
      if (!parts || !extension) continue;
      outputDir ??= await createGoalOutputDir(codexHome, threadId);
      const image = isImageAttachment(attachment);
      const index = image ? ++imageIndex : ++fileIndex;
      const fileName = image ? `image-${index}${extension}` : `file-${index}${extension}`;
      const filePath = path.join(outputDir, fileName);
      await fs.writeFile(filePath, Buffer.from(parts.base64, 'base64'));
      (image ? imageLines : fileLines).push(`- [${image ? 'Image' : 'File'} #${index}]: ${filePath}`);
    }

    let expanded = objective.trim();
    expanded = appendReferenceSection(expanded, 'Referenced image files:', imageLines);
    expanded = appendReferenceSection(expanded, 'Referenced files:', fileLines);
    if ([...expanded].length > MAX_GOAL_OBJECTIVE_CHARS) {
      outputDir ??= await createGoalOutputDir(codexHome, threadId);
      const objectivePath = path.join(outputDir, GOAL_OBJECTIVE_FILE);
      await fs.writeFile(objectivePath, expanded, 'utf8');
      expanded = `Read the Codex goal objective file at ${objectivePath} before continuing.`;
      if ([...expanded].length > MAX_GOAL_OBJECTIVE_CHARS) {
        throw new Error(`Goal objective file reference exceeds ${MAX_GOAL_OBJECTIVE_CHARS} characters`);
      }
    }
    return { objective: expanded, outputDir };
  } catch (error) {
    await cleanupMaterializedGoalDraft(outputDir);
    throw error;
  }
}

export async function cleanupMaterializedGoalDraft(outputDir: string | null): Promise<void> {
  if (!outputDir) return;
  await fs.rm(outputDir, { recursive: true, force: true });
}

export async function cleanupOwnedGoalAttachments(
  codexHome: string | null,
  threadId: string,
  keepOutputDir: string | null,
): Promise<void> {
  if (!codexHome) return;
  const attachmentRoot = path.join(codexHome, GOAL_ATTACHMENT_DIR);
  let entries;
  try {
    entries = await fs.readdir(attachmentRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !GOAL_ATTACHMENT_ID_RE.test(entry.name)) continue;
    const outputDir = path.join(attachmentRoot, entry.name);
    if (outputDir === keepOutputDir) continue;
    try {
      const owner = JSON.parse(await fs.readFile(path.join(outputDir, GOAL_ATTACHMENT_OWNER_FILE), 'utf8'));
      if (owner?.version === 1 && owner.threadId === threadId) await cleanupMaterializedGoalDraft(outputDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
  }
}

async function createGoalOutputDir(codexHome: string | null, threadId: string): Promise<string> {
  if (!codexHome) {
    throw new Error('App server did not report $CODEX_HOME; cannot materialize goal files');
  }
  const outputDir = path.join(codexHome, GOAL_ATTACHMENT_DIR, crypto.randomUUID());
  try {
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, GOAL_ATTACHMENT_OWNER_FILE), JSON.stringify({ version: 1, threadId }), 'utf8');
    return outputDir;
  } catch (error) {
    await cleanupMaterializedGoalDraft(outputDir);
    throw error;
  }
}

function appendReferenceSection(objective: string, heading: string, lines: string[]): string {
  if (!lines.length) return objective;
  return `${objective}${objective.endsWith('\n') ? '\n' : '\n\n'}${heading}\n${lines.join('\n')}`;
}
