// Computes what Bun.which answers on generated PATH layouts, for the `which`
// module of garcon-agents-common. Takes a directory, builds a layout inside
// it, runs every case in its own Bun process (PATH is fixed when a process
// starts, and Bun.which ignores a PATH changed through process.env), and
// prints the cases with Bun's answers as JSON.

import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);
const root = join(process.argv[2]!, 'layout');
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

function executable(path: string, mode = 0o755) {
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, mode);
}

const a = join(root, 'a');
const b = join(root, 'b');
const cwd = join(root, 'cwd');
const sub = join(a, 'sub');
const spaces = join(root, 'space dir');
const locked = join(root, 'locked');
const linked = join(root, 'linked');
for (const directory of [a, b, cwd, sub, spaces, locked]) mkdirSync(directory, { recursive: true });
executable(join(a, 'tool'));
executable(join(a, 'onlya'));
executable(join(a, 'noexec'), 0o644);
executable(join(a, 'both'), 0o600);
executable(join(b, 'tool'));
executable(join(b, 'onlyb'));
executable(join(b, 'both'));
executable(join(cwd, 'tool'));
executable(join(cwd, 'cwdexec'));
executable(join(sub, 'tool'));
executable(join(spaces, 'with space'));
executable(join(spaces, 'line1\nline2'));
executable(join(spaces, 'ünïcödé'));
executable(join(a, 'a\\tool'));
executable(join(a, ' leading'));
executable(join(a, 'TOOL'));
executable(join(a, 'tool.exe'), 0o644);
executable(join(locked, 'tool'));
const modes: Record<string, number> = {
  m010: 0o010, m001: 0o001, m011: 0o011, m110: 0o110, m101: 0o101, m111: 0o111, m711: 0o711,
  m700: 0o700, m400: 0o400, m444: 0o444, m644: 0o644, m750: 0o750, m751: 0o751, m550: 0o550,
  m510: 0o510, m000: 0o000, m4755: 0o4755, m2755: 0o2755, m1777: 0o1777, m100: 0o100,
};
for (const [name, mode] of Object.entries(modes)) executable(join(a, name), mode);
symlinkSync(join(a, 'tool'), join(a, 'link'));
symlinkSync(join(a, 'missing-target'), join(a, 'broken'));
symlinkSync(join(a, 'loop'), join(a, 'loop'));
symlinkSync(a, linked);
const fifo = join(a, 'fifo');
const hasFifo = Bun.spawnSync(['mkfifo', fifo]).exitCode === 0;

// A layout change that holds while one case alone runs; the Rust replay
// applies the same one, by name.
type Hold = 'unsearchable';
const HOLDS: Record<Hold, [prepare: () => void, restore: () => void]> = {
  unsearchable: [() => chmodSync(locked, 0o000), () => chmodSync(locked, 0o755)],
};

interface Case {
  label: string;
  name: string;
  path: string | null;
  cwd: string;
  hold?: Hold;
}
const cases: Case[] = [];
const add = (label: string, name: string, path: string | null = `${a}:${b}`, directory = root, hold?: Hold) => {
  cases.push({ label, name, path, cwd: directory, hold });
};

const P = `${a}:${b}`;
add('first_match', 'tool');
add('reverse_order', 'tool', `${b}:${a}`);
add('only_in_second', 'onlyb');
add('not_executable_anywhere', 'noexec');
add('passed_over_for_a_later_match', 'both');
add('directory_named_tool', 'sub');
add('symlink_to_executable', 'link');
add('broken_symlink', 'broken');
add('symlink_loop', 'loop');
add('missing', 'nothing');
add('case_sensitive_mixed_case', 'Tool');
add('case_sensitive_exact_upper_name', 'TOOL');
add('case_sensitive_lower_file', 'tool', `${a}/TOOL:${b}`);
add('name_with_space', 'with space', `${a}:${spaces}`, root);
add('name_with_newline', 'line1\nline2', `${a}:${spaces}`, root);
add('name_with_unicode', 'ünïcödé', `${a}:${spaces}`, root);
add('name_with_backslash', 'a\\tool');
add('name_leading_space', ' leading');
add('extension_on_linux', 'tool.exe');
if (hasFifo) add('fifo', 'fifo');
for (const name of Object.keys(modes)) add(`mode_${name}`, name, a);
add('relative_entry', 'tool', `bin:${b}`, root);
add('relative_dot_entry', 'tool', `./a:${b}`, root);
add('relative_entry_without_match', 'tool', `sub:${b}`, root);
add('dot_entry', 'tool', `.:${b}`, cwd);
add('empty_leading_segment', 'tool', `:${a}`, cwd);
add('empty_trailing_segment', 'cwdexec', `${b}:`, cwd);
add('empty_middle_segment', 'tool', `${b}::${a}`, cwd);
add('only_colon', 'cwdexec', ':', cwd);
add('empty_path', 'tool', '', cwd);
add('empty_path_cwd_exec', 'cwdexec', '', cwd);
add('path_unset', 'tool', null, cwd);
add('path_only_nonexistent', 'tool', join(root, 'no-such-dir'));
add('entry_with_trailing_slash', 'tool', `${a}/:${b}`);
add('entry_with_two_trailing_slashes', 'tool', `${a}//:${b}`);
add('entry_with_three_trailing_slashes', 'tool', `${a}///:${b}`);
add('entry_dot_slash', 'tool', `./:${b}`, a);
add('entry_dot_double_slash', 'tool', `.//:${b}`, a);
add('entry_only_slash', 'tool', `/:${b}`);
add('entry_only_double_slash', 'tool', `//:${b}`);
add('entry_leading_space', 'tool', ` ${a}:${b}`);
add('entry_trailing_space', 'tool', `${a} :${b}`);
add('entry_symlink_to_directory', 'tool', `${linked}:${b}`);
add('entry_double_slash_inside', 'tool', `${root}//a:${b}`);
add('entry_dot_inside', 'tool', `${root}/./a:${b}`);
add('entry_dotdot_inside', 'tool', `${b}/../a:${b}`);
add('entry_is_a_file', 'tool', `${join(a, 'tool')}:${b}`);
add('entry_unsearchable', 'tool', `${locked}:${b}`, root, 'unsearchable');
add('name_absolute_in_unsearchable', join(locked, 'tool'), b, root, 'unsearchable');
add('entry_searchable_again', 'tool', `${locked}:${b}`);
add('duplicate_entries', 'tool', `${a}:${a}:${b}`);
add('trailing_colons', 'tool', `${a}:::`);
add('entry_tilde', 'tool', `~:${a}`);
add('entry_proc_directory', 'status', '/proc/self', root);

add('name_absolute', join(a, 'tool'), b);
add('name_absolute_noexec', join(a, 'noexec'), b);
add('name_absolute_directory', a, b);
add('name_absolute_trailing_slash', `${a}/`, b);
add('name_absolute_file_trailing_slash', `${a}/tool/`, b);
add('name_absolute_dotdot_inside', `${b}/../a/tool`, b);
add('name_absolute_double_slash_inside', `${a}//tool`, b);
add('name_absolute_leading_two_slashes', `/${a}/tool`, b);
add('name_absolute_leading_three_slashes', `//${a}/tool`, b);
add('name_absolute_leading_four_slashes', `///${a}/tool`, b);
add('name_absolute_symlink_directory', `${linked}/tool`, b);
add('name_absolute_symlink_to_directory', linked, b);
add('name_absolute_broken_symlink', `${a}/broken`, b);
add('name_absolute_missing', `${a}/nothing`, b);
add('name_dev_null', '/dev/null', b);
add('name_proc_file', '/proc/self/status', b);
add('name_relative_dot_slash', './tool', b, a);
add('name_relative_dot_slash_directory', './sub', b, a);
add('name_relative_dot_slash_missing', './nothing', b, a);
add('name_relative_dot_slash_leading_space', './ leading', b, a);
add('name_relative_dot_slash_symlink', './link', b, a);
add('name_relative_dot_slash_noexec', './noexec', b, a);
add('name_relative_dot_dot', '../a/tool', b, b);
add('name_relative_dot_slash_dot_dot', './sub/../tool', b, a);
add('name_relative_directory', 'a/tool', b, root);
add('name_relative_directory_missing', 'sub/tool', b, a);
add('name_relative_double_slash', 'a//tool', b, root);
add('name_relative_dot_inside', 'a/./tool', b, root);
add('name_relative_dot_slash_dot', '././tool', b, a);
add('name_relative_dot_slash_double_slash', './/tool', b, a);
add('name_relative_dot_slash_triple_slash', './//tool', b, a);
add('name_relative_from_root', `${root.slice(1)}/a/tool`, b, '/');
add('name_dot', '.', b, a);
add('name_dot_slash', './', b, a);
add('name_dot_dot', '..', b, a);
add('name_empty', '', b, a);
add('name_slash', '/', b, a);
add('name_tilde', '~/tool', b, a);
add('name_trailing_slash', 'tool/', b, a);

const answers: Array<Case & { expected: string | null }> = [];
for (const entry of cases) {
  const env: Record<string, string> = { PROBE_NAME: entry.name, HOME: process.env.HOME ?? root, TMPDIR: process.env.TMPDIR ?? '/tmp' };
  if (entry.path !== null) env.PATH = entry.path;
  const [prepare, restore] = entry.hold ? HOLDS[entry.hold] : [];
  prepare?.();
  let result: ReturnType<typeof Bun.spawnSync<string>>;
  try {
    result = Bun.spawnSync({
      cmd: [process.execPath, '-e', 'process.stdout.write(JSON.stringify(Bun.which(process.env.PROBE_NAME!)))'],
      env,
      cwd: entry.cwd,
    });
  } finally {
    restore?.();
  }
  if (result.exitCode !== 0) {
    throw new Error(`The child for ${entry.label} exited with ${result.exitCode}: ${new TextDecoder().decode(result.stderr)}`);
  }
  const expected = JSON.parse(new TextDecoder().decode(result.stdout)) as string | null;
  answers.push({ ...entry, holdDirectory: entry.hold ? locked : undefined, expected });
}

process.stdout.write(JSON.stringify({ cases: answers }));
