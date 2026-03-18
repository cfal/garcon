import { describe, expect, it } from 'bun:test';

import {
  BashToolUseMessage,
  EditToolUseMessage,
  GlobToolUseMessage,
  GrepToolUseMessage,
  ReadToolUseMessage,
  UnknownToolUseMessage,
  WebFetchToolUseMessage,
  WebSearchToolUseMessage,
  WriteToolUseMessage,
} from '../../../common/chat-types.js';
import { convertAmpToolUse } from '../converters/amp-tool-use.js';

const TS = '2026-01-01T00:00:00.000Z';

describe('convertAmpToolUse', () => {
  it('maps Bash cmd input to BashToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't1',
      name: 'Bash',
      input: { cmd: 'bun run test', cwd: '/garcon' },
    });

    expect(msg).toBeInstanceOf(BashToolUseMessage);
    expect(msg.command).toBe('bun run test');
  });

  it('maps Read path input to ReadToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't2',
      name: 'Read',
      input: { path: '/garcon/server/providers/amp-cli.js' },
    });

    expect(msg).toBeInstanceOf(ReadToolUseMessage);
    expect(msg.filePath).toBe('/garcon/server/providers/amp-cli.js');
  });

  it('maps edit_file aliases to EditToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't3',
      name: 'edit_file',
      input: { path: '/garcon/file.js', old_str: 'before', new_str: 'after' },
    });

    expect(msg).toBeInstanceOf(EditToolUseMessage);
    expect(msg.filePath).toBe('/garcon/file.js');
    expect(msg.oldString).toBe('before');
    expect(msg.newString).toBe('after');
  });

  it('maps create_file to WriteToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't4',
      name: 'create_file',
      input: { path: '/garcon/new.js', content: 'export const ok = true;' },
    });

    expect(msg).toBeInstanceOf(WriteToolUseMessage);
    expect(msg.filePath).toBe('/garcon/new.js');
    expect(msg.content).toBe('export const ok = true;');
  });

  it('maps glob filePattern to GlobToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't5',
      name: 'glob',
      input: { filePattern: '**/*.ts' },
    });

    expect(msg).toBeInstanceOf(GlobToolUseMessage);
    expect(msg.pattern).toBe('**/*.ts');
  });

  it('maps Grep pattern and path to GrepToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't-grep',
      name: 'Grep',
      input: { pattern: 'TODO:', path: '/garcon/server' },
    });

    expect(msg).toBeInstanceOf(GrepToolUseMessage);
    expect(msg.pattern).toBe('TODO:');
    expect(msg.path).toBe('/garcon/server');
  });

  it('maps web_search objective to WebSearchToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't6',
      name: 'web_search',
      input: {
        objective: 'Bun.spawn stdin options',
        search_queries: ['Bun.spawn stdin options', 'bun subprocess stdin'],
      },
    });

    expect(msg).toBeInstanceOf(WebSearchToolUseMessage);
    expect(msg.query).toBe('Bun.spawn stdin options');
  });

  it('maps read_web_page to WebFetchToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't7',
      name: 'read_web_page',
      input: {
        url: 'https://docs.rs/h2/latest/h2/server/struct.Builder.html',
        objective: 'Find initial_window_size docs',
      },
    });

    expect(msg).toBeInstanceOf(WebFetchToolUseMessage);
    expect(msg.url).toBe('https://docs.rs/h2/latest/h2/server/struct.Builder.html');
    expect(msg.prompt).toBe('Find initial_window_size docs');
  });

  it('leaves finder as UnknownToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't8',
      name: 'finder',
      input: { query: 'Find amp provider startup code' },
    });

    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.rawName).toBe('finder');
  });

  it('leaves oracle as UnknownToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't9',
      name: 'oracle',
      input: { task: 'Review code', files: ['src/a.ts'] },
    });

    expect(msg).toBeInstanceOf(UnknownToolUseMessage);
    expect(msg.input).toEqual({ task: 'Review code', files: ['src/a.ts'] });
  });
});
