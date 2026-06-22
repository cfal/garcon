import { describe, expect, it } from 'bun:test';

import {
  BashToolUseMessage,
  AmpFinderToolUseMessage,
  AmpFindThreadToolUseMessage,
  AmpHandoffToolUseMessage,
  AmpLibrarianToolUseMessage,
  AmpLookAtToolUseMessage,
  AmpMermaidToolUseMessage,
  AmpOracleToolUseMessage,
  AmpReadThreadToolUseMessage,
  AmpSkillToolUseMessage,
  AmpTaskListToolUseMessage,
  EditToolUseMessage,
  GlobToolUseMessage,
  GrepToolUseMessage,
  ReadToolUseMessage,
  WebFetchToolUseMessage,
  WebSearchToolUseMessage,
  WriteToolUseMessage,
} from '../../../../common/chat-types.js';
import { convertAmpToolUse } from '../tool-use-converter.js';

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

  it('maps finder to AmpFinderToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't8',
      name: 'finder',
      input: { query: 'Find amp provider startup code' },
    });

    expect(msg).toBeInstanceOf(AmpFinderToolUseMessage);
    expect(msg.query).toBe('Find amp provider startup code');
  });

  it('maps oracle to AmpOracleToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't9',
      name: 'oracle',
      input: { task: 'Review code', context: 'Focus on auth', files: ['src/a.ts'] },
    });

    expect(msg).toBeInstanceOf(AmpOracleToolUseMessage);
    expect(msg.task).toBe('Review code');
    expect(msg.context).toBe('Focus on auth');
    expect(msg.files).toEqual(['src/a.ts']);
  });

  it('maps librarian to AmpLibrarianToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't10',
      name: 'librarian',
      input: { query: 'Find auth docs', context: 'middleware review' },
    });

    expect(msg).toBeInstanceOf(AmpLibrarianToolUseMessage);
    expect(msg.query).toBe('Find auth docs');
    expect(msg.context).toBe('middleware review');
  });

  it('maps skill to AmpSkillToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't11',
      name: 'skill',
      input: { name: 'lsp' },
    });

    expect(msg).toBeInstanceOf(AmpSkillToolUseMessage);
    expect(msg.name).toBe('lsp');
  });

  it('maps mermaid to AmpMermaidToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't12',
      name: 'mermaid',
      input: {},
    });

    expect(msg).toBeInstanceOf(AmpMermaidToolUseMessage);
  });

  it('maps handoff to AmpHandoffToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't13',
      name: 'handoff',
      input: { goal: 'Continue the implementation' },
    });

    expect(msg).toBeInstanceOf(AmpHandoffToolUseMessage);
    expect(msg.goal).toBe('Continue the implementation');
  });

  it('maps look_at to AmpLookAtToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't14',
      name: 'look_at',
      input: { path: '/garcon/app.css', objective: 'Check theme tokens' },
    });

    expect(msg).toBeInstanceOf(AmpLookAtToolUseMessage);
    expect(msg.path).toBe('/garcon/app.css');
    expect(msg.objective).toBe('Check theme tokens');
  });

  it('maps find_thread to AmpFindThreadToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't15',
      name: 'find_thread',
      input: { query: 'auth session bug' },
    });

    expect(msg).toBeInstanceOf(AmpFindThreadToolUseMessage);
    expect(msg.query).toBe('auth session bug');
  });

  it('maps read_thread to AmpReadThreadToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't16',
      name: 'read_thread',
      input: { threadID: 'thread-123', goal: 'Summarize decisions' },
    });

    expect(msg).toBeInstanceOf(AmpReadThreadToolUseMessage);
    expect(msg.threadId).toBe('thread-123');
    expect(msg.goal).toBe('Summarize decisions');
  });

  it('maps task_list to AmpTaskListToolUseMessage', () => {
    const msg = convertAmpToolUse(TS, {
      id: 't17',
      name: 'task_list',
      input: { action: 'update', taskID: '42', title: 'Ship implementation', status: 'done' },
    });

    expect(msg).toBeInstanceOf(AmpTaskListToolUseMessage);
    expect(msg.action).toBe('update');
    expect(msg.taskId).toBe('42');
    expect(msg.title).toBe('Ship implementation');
    expect(msg.status).toBe('done');
  });
});
