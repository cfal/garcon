import { fileURLToPath } from 'node:url';
import { executionBackend } from './support/execution-backend.js';
import { selectServerSuites } from './support/server-suite-inventory.js';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const backend = executionBackend();
const files = [...new Bun.Glob('tests/server/*.test.{ts,js}').scanSync({ cwd })];
const selected = selectServerSuites(files, backend);
const args = process.argv.slice(2);
if (args.includes('--list')) {
  console.log(selected.join('\n'));
} else {
  console.log(`Server integration: ${backend}, ${selected.length} suites`);
  const child = Bun.spawn([process.execPath, 'test', '--max-concurrency=1', '--timeout=30000', ...args, ...selected], {
    cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit',
  });
  process.exit(await child.exited);
}
