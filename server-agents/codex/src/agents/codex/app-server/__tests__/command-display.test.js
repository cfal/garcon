import { describe, expect, it } from 'bun:test';
import { quote } from 'shell-quote';
import { normalizeCodexCommandDisplay } from '../command-display.ts';

describe('normalizeCodexCommandDisplay', () => {
  it('unwraps Codex Unix shell wrappers', () => {
    const cases = [
      ['/bin/zsh', '-lc'],
      ['/usr/bin/bash', '-c'],
      ['/bin/sh', '-lc'],
      ['C:\\Program Files\\Git\\bin\\bash.exe', '-c'],
    ];

    for (const [shell, flag] of cases) {
      expect(normalizeCodexCommandDisplay(quote([shell, flag, 'git status --short']))).toBe('git status --short');
    }
  });

  it('unwraps the shlex quoting emitted for embedded quotes and variables', () => {
    const command = String.raw`/bin/zsh -lc 'printf '"'"'%s\n'"'"' "$HOME"'`;
    expect(normalizeCodexCommandDisplay(command)).toBe(String.raw`printf '%s\n' "$HOME"`);
  });

  it('preserves multiline scripts and shell syntax inside the wrapped token', () => {
    const script = `cat <<'EOF'
a; b | c
EOF`;
    expect(normalizeCodexCommandDisplay(quote(['/bin/zsh', '-lc', script]))).toBe(script);
  });

  it('unwraps Codex PowerShell wrappers', () => {
    expect(normalizeCodexCommandDisplay(
      quote(['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', 'Get-ChildItem -Force']),
    )).toBe('Get-ChildItem -Force');
    expect(normalizeCodexCommandDisplay(
      quote(['powershell.exe', '-NOPROFILE', '-COMMAND', 'Write-Host hi']),
    )).toBe('Write-Host hi');
  });

  it('unwraps Codex cmd wrappers', () => {
    expect(normalizeCodexCommandDisplay(
      quote(['C:\\Windows\\System32\\cmd.exe', '/C', 'dir /b']),
    )).toBe('dir /b');
  });

  it('removes only the outer transport wrapper', () => {
    expect(normalizeCodexCommandDisplay(
      quote(['/bin/zsh', '-lc', 'bash -lc pwd']),
    )).toBe('bash -lc pwd');
  });

  it('preserves commands that do not match Codex wrapper shapes', () => {
    const commands = [
      '',
      'pwd',
      "/bin/fish -lc 'echo hi'",
      "/bin/zsh -ilc 'echo hi'",
      "/bin/zsh -lc 'echo hi' extra",
      '/bin/zsh -lc foo && bar',
      '/bin/zsh -lc *.ts',
    ];

    for (const command of commands) {
      expect(normalizeCodexCommandDisplay(command)).toBe(command);
    }
  });

  it('preserves malformed or expandable outer command strings', () => {
    const commands = [
      "/bin/zsh -lc 'unterminated",
      '/bin/zsh -lc trailing\\',
      '/bin/zsh -lc "$HOME"',
    ];

    for (const command of commands) {
      expect(normalizeCodexCommandDisplay(command)).toBe(command);
    }
  });
});
