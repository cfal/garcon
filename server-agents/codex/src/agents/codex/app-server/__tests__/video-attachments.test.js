import { describe, expect, it } from "bun:test";
import { promises as fs } from "fs";

import { writeAttachmentsToTempFiles } from "../request-builders.ts";

describe("Codex video attachments", () => {
  it("materializes videos as ordinary files and removes them after the turn", async () => {
    const payload = Buffer.from("video-bytes");
    const materialized = await writeAttachmentsToTempFiles([
      {
        kind: "image",
        name: "clip.mp4",
        mimeType: "video/mp4",
        data: `data:video/mp4;base64,${payload.toString("base64")}`,
      },
    ]);

    expect(materialized.imagePaths).toEqual([]);
    expect(materialized.filePaths).toHaveLength(1);
    expect(materialized.filePaths[0]).toEndWith(".mp4");
    expect(await fs.readFile(materialized.filePaths[0])).toEqual(payload);

    const filePath = materialized.filePaths[0];
    await materialized.cleanup();
    expect(await fs.stat(filePath).catch(() => null)).toBeNull();
  });
});
