import { appendFile } from 'node:fs/promises';

// Replaces the OS browser only inside the smoke test's isolated MIME configuration.
await appendFile(process.env.GARCON_SMOKE_BROWSER_LOG, JSON.stringify(process.argv.slice(2)) + '\n');
