import { promises as fs } from "fs";
import os from "os";
import path from "path";

import type { AgentAttachment } from "@garcon/common/agent-execution";
import { isVideoAttachmentMimeType } from "@garcon/common/attachments";
import {
  attachmentMimeType,
  parseAttachmentDataUrl,
} from "@garcon/server-agent-common/shared/attachments";

const VIDEO_EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-matroska": ".mkv",
};

export interface MaterializedClaudeVideoAttachments {
  readonly command: string;
  readonly filePaths: readonly string[];
  readonly cleanup: () => Promise<void>;
}

export async function materializeClaudeVideoAttachments(
  command: string,
  attachments?: readonly AgentAttachment[],
): Promise<MaterializedClaudeVideoAttachments> {
  const videos = (attachments ?? []).filter((attachment) =>
    isVideoAttachmentMimeType(attachmentMimeType(attachment)),
  );
  if (videos.length === 0) {
    return { command, filePaths: [], cleanup: async () => {} };
  }

  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "claude-video-attachments-"),
  );
  const filePaths: string[] = [];
  try {
    for (let index = 0; index < videos.length; index++) {
      const attachment = videos[index];
      const parts = parseAttachmentDataUrl(attachment.data);
      const mimeType = attachmentMimeType(attachment);
      const extension = VIDEO_EXTENSIONS[mimeType];
      if (!parts || !extension) continue;
      const filePath = path.join(tmpDir, `video-${index}${extension}`);
      await fs.writeFile(filePath, Buffer.from(parts.base64, "base64"));
      filePaths.push(filePath);
    }
  } catch (error) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const cleanup = async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  };
  if (filePaths.length === 0) return { command, filePaths, cleanup };

  const references = filePaths
    .map((filePath) => `- Video: ${filePath}`)
    .join("\n");
  return {
    command: [
      command,
      "Attached videos are available on disk:",
      references,
    ].join("\n\n"),
    filePaths,
    cleanup,
  };
}
