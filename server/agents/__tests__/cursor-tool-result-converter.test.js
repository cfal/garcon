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

  it('preserves Cursor ACP grep total match counts when file lists are unavailable', () => {
    const content = normalizeCursorToolResultContent(
      'search',
      { totalMatches: 17, truncated: false },
    );

    expect(content).toEqual({
      filenames: [],
      totalMatches: 17,
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
});
