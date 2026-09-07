import { describe, expect, it } from "bun:test";
import { promises as fs } from "fs";

import { materializeClaudeVideoAttachments } from "../video-attachments.ts";

describe("Claude video attachments", () => {
  it("adds readable video paths to the prompt and cleans them up", async () => {
    const payload = Buffer.from("video-bytes");
    const materialized = await materializeClaudeVideoAttachments(
      "Inspect this clip",
      [
        {
          kind: "image",
          name: "clip.webm",
          mimeType: "video/webm",
          data: `data:video/webm;base64,${payload.toString("base64")}`,
        },
      ],
    );

    expect(materialized.filePaths).toHaveLength(1);
    expect(materialized.filePaths[0]).toEndWith(".webm");
    expect(materialized.command).toContain(
      "Attached videos are available on disk:",
    );
    expect(materialized.command).toContain(materialized.filePaths[0]);
    expect(await fs.readFile(materialized.filePaths[0])).toEqual(payload);

    const filePath = materialized.filePaths[0];
    await materialized.cleanup();
    expect(await fs.stat(filePath).catch(() => null)).toBeNull();
  });

  it("leaves non-video attachment handling unchanged", async () => {
    const materialized = await materializeClaudeVideoAttachments("Read this", [
      {
        kind: "image",
        name: "notes.txt",
        mimeType: "text/plain",
        data: "data:text/plain;base64,bm90ZXM=",
      },
    ]);

    expect(materialized.command).toBe("Read this");
    expect(materialized.filePaths).toEqual([]);
  });
});
