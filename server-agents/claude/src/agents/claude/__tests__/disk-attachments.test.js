import { describe, expect, it } from "bun:test";
import { promises as fs } from "fs";

import { materializeClaudeDiskAttachments } from "../disk-attachments.ts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function attachment(name, mimeType, bytes) {
  return {
    kind: "image",
    name,
    mimeType,
    data: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
  };
}

describe("Claude disk attachments", () => {
  it("adds readable paths for videos and spreadsheets and cleans them up", async () => {
    const materialized = await materializeClaudeDiskAttachments("Inspect these", [
      attachment("clip.webm", "video/webm", "video-bytes"),
      attachment("budget.xlsx", XLSX_MIME, "sheet-bytes"),
    ]);

    expect(materialized.filePaths).toHaveLength(2);
    expect(materialized.filePaths[0]).toEndWith("clip.webm");
    expect(materialized.filePaths[1]).toEndWith("budget.xlsx");
    expect(materialized.command).toContain("Attached files are available on disk:");
    expect(materialized.command).toContain(materialized.filePaths[1]);
    expect(await fs.readFile(materialized.filePaths[1], "utf8")).toBe("sheet-bytes");

    await materialized.cleanup();
    for (const filePath of materialized.filePaths) {
      expect(await fs.stat(filePath).catch(() => null)).toBeNull();
    }
  });

  it("leaves inline image, PDF, and text attachments in the prompt", async () => {
    const materialized = await materializeClaudeDiskAttachments("Read this", [
      attachment("notes.txt", "text/plain", "notes"),
      attachment("table.csv", "text/csv", "a,b"),
      attachment("spec.pdf", "application/pdf", "pdf"),
      attachment("shot.png", "image/png", "png"),
    ]);

    expect(materialized.command).toBe("Read this");
    expect(materialized.filePaths).toEqual([]);
    expect(materialized.inlineAttachments).toHaveLength(4);
  });

  it("writes text too long to inline to disk instead of truncating it", async () => {
    const large = attachment("large.csv", "text/csv", "a,b\n".repeat(40_000));
    const materialized = await materializeClaudeDiskAttachments("Analyze", [large]);

    expect(materialized.inlineAttachments).toEqual([]);
    expect(materialized.filePaths[0]).toEndWith("large.csv");
    expect((await fs.stat(materialized.filePaths[0])).size).toBe(160_000);
    await materialized.cleanup();
  });
});
