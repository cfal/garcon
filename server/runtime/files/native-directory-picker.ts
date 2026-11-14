import type { ExecutorCallOptions } from '@garcon/server-agent-interface';
import { parseDirectorySelectionResult, type DirectorySelectionResult } from '../../../common/file-contracts.js';
import { DomainError } from '../../common/domain-error.js';

export type NativeDirectoryPicker = (directoryPath: string, options?: ExecutorCallOptions) => Promise<DirectorySelectionResult>;

interface PickerProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

interface PickerCommand {
  readonly argv: string[];
  readonly input?: string;
}

export interface NativeDirectoryPickerDependencies {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly which: (command: string) => string | null;
  readonly spawn: (command: PickerCommand) => PickerProcess;
}

const MAX_TIMEOUT_MS = 300_000;
const MAX_STREAM_BYTES = 8191;
let dialogActive = false;

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
if (![Environment]::UserInteractive -or [System.Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0) {
  [Console]::Write('{"status":"unsupported"}')
  exit 0
}
$config = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
try {
  $dialog.Description = 'Choose a folder for Garcon'
  $dialog.SelectedPath = $config.directoryPath
  $dialog.ShowNewFolderButton = $true
  if ($dialog.PSObject.Properties['AutoUpgradeEnabled']) { $dialog.AutoUpgradeEnabled = $true }
  if ($dialog.PSObject.Properties['UseDescriptionForTitle']) { $dialog.UseDescriptionForTitle = $true }
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Write((@{status='selected';path=$dialog.SelectedPath} | ConvertTo-Json -Compress))
  } else { [Console]::Write('{"status":"cancelled"}') }
} finally { $dialog.Dispose() }
`;

const MAC_SCRIPT = `on run argv
  try
    set chosenFolder to choose folder with prompt "Choose a folder for Garcon" default location (POSIX file (item 1 of argv))
    return POSIX path of chosenFolder
  on error number -128
    return ""
  end try
end run`;

function withoutOutputNewline(output: string): string {
  return output.replace(/\r?\n$/, '');
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_STREAM_BYTES) throw new Error('Native folder picker output exceeded its limit');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally {
    reader.releaseLock();
  }
}

/** Keeps dialog admission until the owned helper and its bounded output have settled. */
export function createNativeDirectoryPicker(dependencies: NativeDirectoryPickerDependencies): NativeDirectoryPicker {
  return async (directoryPath, options) => {
    options?.signal?.throwIfAborted();
    if (dialogActive) throw new DomainError('FILE_SERVICE_BUSY', 'A folder selection dialog is already open', 429, true);
    dialogActive = true;
    const abort = new AbortController();
    const timeoutMs = Math.min(options?.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => abort.abort(new DomainError('REQUEST_TIMEOUT', 'Folder selection timed out', 408)), timeoutMs);
    const onAbort = () => abort.abort(options?.signal?.reason);
    options?.signal?.addEventListener('abort', onAbort, { once: true });

    const run = async (command: PickerCommand) => {
      abort.signal.throwIfAborted();
      const helper = dependencies.spawn(command);
      const kill = () => { try { helper.kill(); } catch { /* The owned helper may have already exited. */ } };
      abort.signal.addEventListener('abort', kill, { once: true });
      const tasks = [readBounded(helper.stdout), readBounded(helper.stderr), helper.exited] as const;
      const output = Promise.all(tasks);
      try {
        const [stdout, stderr, code] = await output;
        abort.signal.throwIfAborted();
        return { stdout, stderr, code };
      } catch (error) {
        kill();
        await Promise.allSettled(tasks);
        abort.signal.throwIfAborted();
        throw error;
      } finally {
        abort.signal.removeEventListener('abort', kill);
      }
    };

    try {
      const { platform, environment, which } = dependencies;
      if (environment.CI || environment.SSH_CONNECTION || environment.SSH_TTY) return { status: 'unsupported' };
      if (platform === 'win32') {
        const powershell = which('pwsh.exe') ?? which('powershell.exe');
        if (!powershell) return { status: 'unsupported' };
        const result = await run({
          argv: [powershell, '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')],
          input: JSON.stringify({ directoryPath }),
        });
        if (result.code !== 0) throw new Error('Native folder picker failed');
        let parsed: DirectorySelectionResult | null = null;
        try { parsed = parseDirectorySelectionResult(JSON.parse(result.stdout)); } catch { /* Invalid helper output is a failed selection. */ }
        if (!parsed) throw new Error('Native folder picker returned an invalid result');
        return parsed;
      }
      if (platform === 'darwin') {
        const launchctl = which('launchctl');
        const osascript = which('osascript');
        if (!launchctl || !osascript) return { status: 'unsupported' };
        const session = await run({ argv: [launchctl, 'managername'] });
        if (session.code !== 0 || session.stdout.trim() !== 'Aqua') return { status: 'unsupported' };
        const result = await run({ argv: [osascript, '-e', MAC_SCRIPT, directoryPath] });
        if (result.code !== 0) throw new Error('Native folder picker failed');
        const selected = withoutOutputNewline(result.stdout);
        return selected ? { status: 'selected', path: selected } : { status: 'cancelled' };
      }
      if (platform === 'linux') {
        if (!environment.DISPLAY && !environment.WAYLAND_DISPLAY) return { status: 'unsupported' };
        const zenity = which('zenity');
        const kdialog = zenity ? null : which('kdialog');
        if (!zenity && !kdialog) return { status: 'unsupported' };
        const result = await run({ argv: zenity
          ? [zenity, '--file-selection', '--directory', '--title=Choose a folder for Garcon', `--filename=${directoryPath.endsWith('/') ? directoryPath : `${directoryPath}/`}`]
          : [kdialog!, '--getexistingdirectory', directoryPath, '--title', 'Choose a folder for Garcon'],
        });
        if (/cannot open display|could not connect to display|cannot initialize gtk|qt platform plugin/i.test(result.stderr)) return { status: 'unsupported' };
        if (result.code === 1 && !result.stdout) return { status: 'cancelled' };
        if (result.code !== 0) throw new Error('Native folder picker failed');
        const selected = withoutOutputNewline(result.stdout);
        if (!selected) throw new Error('Native folder picker returned an invalid result');
        return { status: 'selected', path: selected };
      }
      return { status: 'unsupported' };
    } finally {
      clearTimeout(timer);
      options?.signal?.removeEventListener('abort', onAbort);
      dialogActive = false;
    }
  };
}

export const chooseNativeDirectory: NativeDirectoryPicker = createNativeDirectoryPicker({
  platform: process.platform,
  environment: process.env,
  which: (command) => Bun.which(command),
  spawn: (command) => Bun.spawn(command.argv, {
    stdin: command.input === undefined ? 'ignore' : Buffer.from(command.input),
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  }),
});
