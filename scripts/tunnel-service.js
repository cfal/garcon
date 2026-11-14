import path from 'node:path';
import { writeOwnedFile, runCommand } from './cloudflare-tunnel.js';

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const ps = value => `'${value.replaceAll("'", "''")}'`;
const unit = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$').replaceAll('\n', '\\n').replaceAll('\r', '\\r')}"`;

export function tunnelService({ platform, home, directory, command, uid, windowsDirectory, configHome }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'linux') {
    if (configHome && !paths.isAbsolute(configHome)) throw new Error('XDG_CONFIG_HOME must be an absolute path.');
    const file = paths.join(configHome || paths.join(home, '.config'), 'systemd/user/garcon-tunnel.service');
    return {
      files: [[file, `[Unit]\nDescription=Garcon Cloudflare Tunnel\nAfter=network-online.target\n\n[Service]\nExecStart=${command.map(unit).join(' ')}\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`]],
      commands: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', 'garcon-tunnel.service']],
    };
  }
  if (platform === 'darwin') {
    const file = paths.join(home, 'Library/LaunchAgents/app.garcon.tunnel.plist');
    const label = `gui/${uid}/app.garcon.tunnel`;
    return {
      files: [[file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>app.garcon.tunnel</string>\n<key>ProgramArguments</key><array>${command.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n<key>ThrottleInterval</key><integer>10</integer>\n<key>StandardOutPath</key><string>${xml(path.join(directory, 'tunnel.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(directory, 'tunnel.log'))}</string>\n</dict></plist>\n`]],
      commands: [['launchctl', 'enable', label]],
      bootstrap: ['launchctl', 'bootstrap', `gui/${uid}`, file],
      probe: ['launchctl', 'print', label],
    };
  }
  if (platform !== 'win32') throw new Error('Automatic tunnel startup supports Linux, macOS, and Windows.');
  const runner = paths.join(directory, 'run-tunnel.ps1');
  const powershell = path.win32.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Windows command-line quoting keeps a path containing spaces within one -File argument.
  if (runner.includes('"')) throw new Error('The tunnel directory cannot contain a double quote.');
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${runner}"`;
  // PowerShell 5 requires a BOM for Unicode paths and can treat native stderr as errors.
  const script = `\uFEFF$ErrorActionPreference = 'Continue'\n$exe = ${ps(command[0])}\n$argsForTunnel = @(${command.slice(1).map(ps).join(', ')})\nwhile ($true) {\n  & $exe @argsForTunnel *>> ${ps(paths.join(directory, 'tunnel.log'))}\n  Start-Sleep -Seconds 10\n}\n`;
  const registration = `$ErrorActionPreference = 'Stop'
$exe = ${ps(powershell)}
$arguments = ${ps(args)}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$user = $identity.Name
$existing = Get-ScheduledTask -TaskName 'GarconTunnel' -ErrorAction SilentlyContinue
if ($existing) {
  if ($existing.Actions.Count -ne 1 -or $existing.Actions[0].Execute -ne $exe -or $existing.Actions[0].Arguments -ne $arguments) { throw 'GarconTunnel already belongs to another configuration.' }
  if ($existing.Principal.UserId -notin @($user, $identity.User.Value) -or $existing.Principal.RunLevel -ne 'Limited' -or $existing.Principal.LogonType -ne 'Interactive') { throw 'GarconTunnel must run as the current user with limited interactive rights. Remove the conflicting task before rerunning setup.' }
} else {
  $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'GarconTunnel' -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
}
Start-ScheduledTask -TaskName 'GarconTunnel'
`;
  return { files: [[runner, script]], commands: [[powershell, '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(registration, 'utf16le').toString('base64')]] };
}

export async function installTunnelService(options) {
  const service = tunnelService(options);
  for (const [file, contents] of service.files) await writeOwnedFile(file, contents);
  for (const command of service.commands) await runCommand(command);
  if (service.probe) {
    const probe = Bun.spawn(service.probe, { stdout: 'ignore', stderr: 'ignore' });
    if (await probe.exited !== 0) await runCommand(service.bootstrap);
  }
}
