import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeWorkflows } from '../setup.js';

test('a fenced workflow store cannot break ordinary chat deletion or drop reference protection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-isolation-'));
  const unexpected = () => { throw new Error('No selection or dispatch expected'); };
  const runtime = initializeWorkflows(dir, { runner: { run: unexpected } }, {
    ready: unexpected, catalog: unexpected, inspectProject: unexpected, recents: unexpected, defaults: unexpected, preambles: unexpected, providerRoute: unexpected,
  });
  try {
    await runtime.start();
    const db = new Database(join(dir, 'workflow-runs.sqlite'), { readonly: false });
    try { db.exec('DROP TABLE workflow_attempts'); } finally { db.close(); }
    expect(() => runtime.handleChatRemoved('ordinary-chat')).not.toThrow();
    expect(() => runtime.service).toThrow('unavailable');
    expect(runtime.referencesApiProvider('provider')).toBe(true);
    expect(runtime.referencesExecutor('remote')).toBe(true);
  } finally {
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
