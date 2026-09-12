import { spawn } from 'node:child_process';

if (process.argv[2] === 'argv') {
  console.log(JSON.stringify(process.argv.slice(3)));
  process.exit(0);
}

if (process.argv[2] === 'inert') {
  const timeout = setTimeout(() => process.exit(1), 15_000);
  console.log(JSON.stringify({ mainPid: process.pid }));
  for await (const _ of Bun.stdin.stream()) { /* An inert fixture never interprets configuration or starts children. */ }
  clearTimeout(timeout);
  process.exit(0);
}

process.on('SIGTERM', () => {});
setTimeout(() => process.exit(0), 15_000);

if (process.argv[2] === 'child') {
  console.log('ready');
} else {
  const child = spawn(process.execPath, [import.meta.path, 'child'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve());
  });
  console.log(JSON.stringify({ mainPid: process.pid, childPid: child.pid }));
  for await (const chunk of Bun.stdin.stream()) {
    if (new TextDecoder().decode(chunk).includes('crash')) process.kill(process.pid, 'SIGKILL');
  }
}
