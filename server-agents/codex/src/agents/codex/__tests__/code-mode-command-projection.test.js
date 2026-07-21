import { describe, expect, it } from 'bun:test';
import { BashToolUseMessage } from '@garcon/common/chat-types';
import {
  codexCodeModeBashToolId,
  codexCodeModeResultToolId,
  createCodexCodeModeBashMessages,
  projectCodexCodeModeCommands,
  rememberCodexCodeModeResult,
  rewriteCodexCodeModeCommandPrefix,
} from '../code-mode-command-projection.js';

const TS = '2026-07-21T12:00:00.000Z';

describe('projectCodexCodeModeCommands', () => {
  it('projects a direct command with JavaScript object syntax and local reporting', () => {
    const source = `// @exec: {"yield_time_ms": 1000}
const result = await tools.exec_command({
  cmd: "printf 'one;two\\n'",
  workdir: "/repo",
  yield_time_ms: 1000,
});
text(result.output)
if (result.exit_code !== undefined) text(String(result.exit_code));`;

    expect(projectCodexCodeModeCommands(source)).toEqual({
      commands: ["printf 'one;two\n'"],
    });
  });

  it('projects a direct no-expression template command', () => {
    expect(projectCodexCodeModeCommands(`
      const result = await tools.exec_command({ cmd: \`git status\` });
      text(JSON.stringify(result));
    `)).toEqual({ commands: ['git status'] });
  });

  it('projects a literal Promise list in source order', () => {
    const source = `
      const results = await Promise.all([
        tools.exec_command({cmd: "git status"}),
        tools.exec_command({cmd: "git diff --stat", max_output_tokens: 4000}),
        await tools.exec_command({cmd: "git log -1"}),
      ]);
      results.forEach((result, index) => text(\`CMD\${index + 1}\\n\${result.output}\`));
    `;

    expect(projectCodexCodeModeCommands(source)).toEqual({
      commands: ['git status', 'git diff --stat', 'git log -1'],
    });
  });

  it('projects a static string list mapped through an expression callback', () => {
    const source = `
      const commands = ["git status", "git diff --stat"];
      const results = await Promise.all(
        commands.map(async cmd => await tools.exec_command({cmd, workdir: "/repo"})),
      );
      text(results.join("\\n\\n"));
    `;

    expect(projectCodexCodeModeCommands(source)).toEqual({
      commands: ['git status', 'git diff --stat'],
    });
  });

  it('projects static tuples mapped through destructuring and local formatting', () => {
    const source = `
      const commands = [
        ["git status", "/repo"],
        ["git diff --stat", "/repo"],
      ];
      const results = await Promise.all(commands.map(async ([cmd, workdir]) => {
        const result = await tools.exec_command({cmd, workdir, yield_time_ms: 1000});
        return \`\${cmd}\\n\${result.output}\`;
      }));
      text(results.join("\\n\\n"));
    `;

    expect(projectCodexCodeModeCommands(source)).toEqual({
      commands: ['git status', 'git diff --stat'],
    });
  });

  it('projects a fixed tuple member from an identifier binding', () => {
    const source = `
      const entries = [["status", "git status"], ["diff", "git diff"]];
      const results = await Promise.all(
        entries.map(entry => tools.exec_command({cmd: entry[1]})),
      );
      for (const result of results) text(result.output);
    `;

    expect(projectCodexCodeModeCommands(source)).toEqual({
      commands: ['git status', 'git diff'],
    });
  });

  it('returns null for unsafe, dynamic, or unsupported programs', () => {
    const rejected = [
      'const result = await tools.exec_command({cmd: "git status"}',
      'const result = await tools.exec_command({cmd: prefix + " status"}); text(result.output);',
      'const result = await tools.exec_command({cmd: `git ${mode}`}); text(result.output);',
      'if (enabled) { const result = await tools.exec_command({cmd: "git status"}); text(result.output); }',
      'const result = await tools.exec_command({cmd: "git status", workdir: locateRepo()}); text(result.output);',
      'const result = await tools.exec_command({cmd: "git status"}); notify(result.output);',
      'const result = await tools.exec_command({cmd: "git status"}); store("result", result);',
      'const result = await tools.exec_command({cmd: "git status"}); setTimeout(() => text(result.output), 0);',
      'const result = await tools.exec_command({cmd: "git status"}); tools.write_stdin({chars: "x"});',
      'const tools = {exec_command: fake}; const result = await tools.exec_command({cmd: "git status"}); text(result);',
      'const text = value => value; const result = await tools.exec_command({cmd: "git status"}); text(result);',
      'const result = await tools?.exec_command?.({cmd: "git status"}); text(result);',
      'const a = await tools.exec_command({cmd: "a"}); const b = await tools.exec_command({cmd: "b"}); text(a.output);',
      'const commands = getCommands(); const results = await Promise.all(commands.map(cmd => tools.exec_command({cmd}))); text(results);',
      'const commands = ["a", "b"]; commands.push("c"); const results = await Promise.all(commands.map(cmd => tools.exec_command({cmd}))); text(results);',
      'const commands = ["a", "b"]; const results = await Promise.all(commands.filter(Boolean).map(cmd => tools.exec_command({cmd}))); text(results);',
      'const commands = ["a", "b"]; const results = await Promise.all(commands.map(cmd => enabled ? tools.exec_command({cmd}) : null)); text(results);',
      'const commands = ["a", ...more]; const results = await Promise.all(commands.map(cmd => tools.exec_command({cmd}))); text(results);',
      'const results = await Promise.all([tools.exec_command({cmd: "a"}), tools.web__run({})]); text(results);',
      'const results = await Promise.all([]); text(results);',
    ];

    for (const source of rejected) {
      expect(projectCodexCodeModeCommands(source), source).toBeNull();
    }
  });

  it('bounds source size and command amplification', () => {
    const oversizedSource = `const result = await tools.exec_command({cmd: "a"}); text(result.output);${' '.repeat(65 * 1024)}`;
    const commands = Array.from({ length: 65 }, (_, index) => `"command-${index}"`).join(',');
    const oversizedBatch = `
      const commands = [${commands}];
      const results = await Promise.all(commands.map(cmd => tools.exec_command({cmd})));
      text(results);
    `;

    expect(projectCodexCodeModeCommands(oversizedSource)).toBeNull();
    expect(projectCodexCodeModeCommands(oversizedBatch)).toBeNull();
  });
});

describe('Code Mode Bash message projection', () => {
  it('creates stable synthetic IDs and associates results with the final command', () => {
    const projection = { commands: ['git status', 'git diff'] };
    const messages = createCodexCodeModeBashMessages(TS, 'outer-call', projection);

    expect(messages).toHaveLength(2);
    expect(messages.every((message) => message instanceof BashToolUseMessage)).toBe(true);
    expect(messages).toMatchObject([
      { toolId: 'codex-code-mode:outer-call:0', command: 'git status' },
      { toolId: 'codex-code-mode:outer-call:1', command: 'git diff' },
    ]);
    expect(codexCodeModeBashToolId('outer-call', 0)).toBe(messages[0].toolId);
    expect(codexCodeModeResultToolId('outer-call', projection)).toBe(messages[1].toolId);
  });

  it('rewrites a command prefix into a round-trippable canonical program', () => {
    const commands = [
      'printf "one;two\\n"',
      'printf "${literal} `ticks` \\n"',
    ];
    const source = rewriteCodexCodeModeCommandPrefix(commands);

    expect(projectCodexCodeModeCommands(source)).toEqual({ commands });
  });

  it('bounds pending result associations', () => {
    const resultToolIds = new Map();
    for (let index = 0; index <= 10_000; index += 1) {
      rememberCodexCodeModeResult(resultToolIds, `outer-${index}`, `result-${index}`);
    }

    expect(resultToolIds.size).toBe(10_000);
    expect(resultToolIds.has('outer-0')).toBe(false);
    expect(resultToolIds.get('outer-10000')).toBe('result-10000');
  });
});
