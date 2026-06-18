import { describe, expect, it } from 'bun:test';

import { normalizeCursorToolResultContent } from '../cursor/tool-result-converter.js';

describe('normalizeCursorToolResultContent', () => {
  it('maps Cursor high-level Glob results to canonical file lists', () => {
    const content = normalizeCursorToolResultContent(
      'Glob',
      'Result of search in "" (total 24 files):\n- ./contracts/a/daml.yaml\n',
      {
        output: {
          success: {
            files: ['./contracts/a/daml.yaml', './contracts/b/daml.yaml'],
            totalFiles: 2,
          },
        },
      },
    );

    expect(content).toEqual({
      filenames: ['./contracts/a/daml.yaml', './contracts/b/daml.yaml'],
      numFiles: 2,
    });
  });

  it('parses Cursor textual Glob results when high-level metadata is absent', () => {
    const content = normalizeCursorToolResultContent(
      'Glob',
      'Result of search in "" (total 2 files):\n- ./one.ts\n- ./two.ts\n',
    );

    expect(content).toEqual({
      filenames: ['./one.ts', './two.ts'],
      numFiles: 2,
    });
  });

  it('maps Cursor high-level Read results without line-number decoration', () => {
    const content = normalizeCursorToolResultContent(
      'Read',
      '     1|sdk-version: 3.4.11\n',
      {
        output: {
          success: {
            content: 'sdk-version: 3.4.11\n',
            totalLines: 1,
            fileSize: 24,
            path: '/repo/daml.yaml',
            readRange: { startLine: 1, endLine: 1 },
          },
        },
      },
    );

    expect(content).toEqual({
      content: 'sdk-version: 3.4.11\n',
      totalLines: 1,
      fileSize: 24,
      path: '/repo/daml.yaml',
      readRange: { startLine: 1, endLine: 1 },
    });
  });

  it('maps Cursor stream-json Read completion results without high-level metadata', () => {
    const content = normalizeCursorToolResultContent(
      'Read',
      {
        success: {
          content: 'export const value = 1;\n',
          totalLines: 1,
          fileSize: 24,
          path: '/repo/src/app.ts',
          readRange: { startLine: 1, endLine: 1 },
        },
      },
    );

    expect(content).toEqual({
      content: 'export const value = 1;\n',
      totalLines: 1,
      fileSize: 24,
      path: '/repo/src/app.ts',
      readRange: { startLine: 1, endLine: 1 },
    });
  });

  it('maps Cursor stream-json Grep workspace results to files and match metadata', () => {
    const content = normalizeCursorToolResultContent(
      'Grep',
      {
        success: {
          pattern: 'convertCursorToolUse',
          path: '/repo/server/agents/cursor',
          outputMode: 'content',
          workspaceResults: {
            '/repo': {
              content: {
                matches: [
                  {
                    file: 'server/agents/cursor/tool-use-converter.ts',
                    matches: [
                      {
                        lineNumber: 158,
                        content: 'export function convertCursorToolUse(...)',
                        contentTruncated: false,
                        isContextLine: false,
                      },
                    ],
                  },
                  {
                    file: 'server/agents/cursor/cursor-acp-event-converter.ts',
                    matches: [
                      {
                        lineNumber: 289,
                        content: 'return convertCursorToolUse(context.timestamp, {',
                        contentTruncated: false,
                        isContextLine: false,
                      },
                    ],
                  },
                ],
                totalLines: 2,
                totalMatchedLines: 2,
                clientTruncated: false,
                ripgrepTruncated: false,
              },
            },
          },
        },
      },
    );

    expect(content).toEqual({
      filenames: [
        'server/agents/cursor/tool-use-converter.ts',
        'server/agents/cursor/cursor-acp-event-converter.ts',
      ],
      numFiles: 2,
      totalMatches: 2,
      matches: [
        {
          file: 'server/agents/cursor/tool-use-converter.ts',
          matches: [
            {
              lineNumber: 158,
              content: 'export function convertCursorToolUse(...)',
              contentTruncated: false,
              isContextLine: false,
            },
          ],
        },
        {
          file: 'server/agents/cursor/cursor-acp-event-converter.ts',
          matches: [
            {
              lineNumber: 289,
              content: 'return convertCursorToolUse(context.timestamp, {',
              contentTruncated: false,
              isContextLine: false,
            },
          ],
        },
      ],
      pattern: 'convertCursorToolUse',
      path: '/repo/server/agents/cursor',
    });
  });
});
