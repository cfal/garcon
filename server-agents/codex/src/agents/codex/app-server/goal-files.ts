import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import type { AgentAttachment } from '@garcon/common/agent-execution';
import { attachmentMimeType, isImageAttachment, parseAttachmentDataUrl } from '@garcon/server-agent-common/shared/attachments';

const MAX_GOAL_OBJECTIVE_CHARS = 4_000;
const GOAL_ATTACHMENT_DIR = 'attachments';
const GOAL_OBJECTIVE_FILE = 'goal-objective.md';
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

export interface MaterializedGoalDraft {
  objective: string;
  outputDir: string | null;
}

export async function materializeGoalDraft(
  codexHome: string | null,
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
      outputDir ??= await createGoalOutputDir(codexHome);
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
      outputDir ??= await createGoalOutputDir(codexHome);
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

async function createGoalOutputDir(codexHome: string | null): Promise<string> {
  if (!codexHome) {
    throw new Error('App server did not report $CODEX_HOME; cannot materialize goal files');
  }
  const outputDir = path.join(codexHome, GOAL_ATTACHMENT_DIR, crypto.randomUUID());
  await fs.mkdir(outputDir, { recursive: true });
  return outputDir;
}

function appendReferenceSection(objective: string, heading: string, lines: string[]): string {
  if (!lines.length) return objective;
  return `${objective}${objective.endsWith('\n') ? '\n' : '\n\n'}${heading}\n${lines.join('\n')}`;
}
