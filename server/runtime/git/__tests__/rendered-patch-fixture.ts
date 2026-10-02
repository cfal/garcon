import type { GitReviewDocumentFileBodiesResponse } from "../types.js";
import type { GitRenderedDiffRow, GitRenderedHunk } from "../types.js";

export interface ParsedRenderedPatch {
  rows: GitRenderedDiffRow[];
  hunks: GitRenderedHunk[];
}

export function parseUnifiedPatchToRenderedRows(
  diffText: string,
  options: { allowMultipleFileSections?: boolean } = {},
): ParsedRenderedPatch {
  const lines = diffText.split('\n');
  const rows: GitRenderedDiffRow[] = [];
  const hunks: GitRenderedHunk[] = [];
  let beforeLine = 0;
  let afterLine = 0;
  let diffLineIndex = 0;
  let currentHunkIndex = -1;
  let sawFileHeader = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === '' && lineIndex === lines.length - 1) continue;
    if (line.startsWith('diff --git ')) {
      if (sawFileHeader && !options.allowMultipleFileSections) break;
      sawFileHeader = true;
      currentHunkIndex = -1;
      continue;
    }

    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (hunkMatch) {
      currentHunkIndex = hunks.length;
      beforeLine = Number(hunkMatch[1]);
      afterLine = Number(hunkMatch[3]);
      const hunkId = `hunk-${currentHunkIndex}`;
      rows.push({
        key: `hunk:${currentHunkIndex}:${hunkId}`,
        kind: 'hunk',
        hunkIndex: currentHunkIndex,
        hunkId,
        beforeLine: null,
        afterLine: null,
        text: line,
        diffLineIndex: -1,
      });
      hunks.push({
        id: hunkId,
        header: line,
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] ? Number(hunkMatch[4]) : 1,
        rowStartIndex: rows.length - 1,
        rowEndIndex: rows.length - 1,
      });
      continue;
    }

    if (currentHunkIndex < 0 || line.startsWith('\\')) continue;
    const hunk = hunks[currentHunkIndex];

    if (line.startsWith('-')) {
      rows.push({
        key: `line:${diffLineIndex}:del:${beforeLine}`,
        kind: 'del',
        hunkIndex: currentHunkIndex,
        hunkId: hunk.id,
        beforeLine,
        afterLine: null,
        text: line.slice(1),
        diffLineIndex,
      });
      beforeLine += 1;
      diffLineIndex += 1;
    } else if (line.startsWith('+')) {
      rows.push({
        key: `line:${diffLineIndex}:add:${afterLine}`,
        kind: 'add',
        hunkIndex: currentHunkIndex,
        hunkId: hunk.id,
        beforeLine: null,
        afterLine,
        text: line.slice(1),
        diffLineIndex,
      });
      afterLine += 1;
      diffLineIndex += 1;
    } else if (line.startsWith(' ') || line === '') {
      rows.push({
        key: `line:${diffLineIndex}:context:${beforeLine}:${afterLine}`,
        kind: 'context',
        hunkIndex: currentHunkIndex,
        hunkId: hunk.id,
        beforeLine,
        afterLine,
        text: line.startsWith(' ') ? line.slice(1) : '',
        diffLineIndex,
      });
      beforeLine += 1;
      afterLine += 1;
      diffLineIndex += 1;
    }

    hunk.rowEndIndex = rows.length - 1;
  }

  return { rows, hunks };
}

export function materializeReviewResponse(response: GitReviewDocumentFileBodiesResponse) {
  if (response.status !== "ready") return response;
  return {
    ...response,
    files: Object.fromEntries(
      Object.entries(response.files).map(([filePath, body]) => {
        const rendered = body.patch
          ? parseUnifiedPatchToRenderedRows(body.patch, {
              allowMultipleFileSections: true,
            })
          : { rows: [], hunks: [] };
        return [filePath, { ...body, ...rendered }];
      }),
    ),
  };
}
