import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveAgentStandaloneEntrypoint } from '@garcon/server-agent-common/build/standalone-entrypoint';

const PLUGIN_SOURCE = resolveAgentStandaloneEntrypoint({
  integrationId: 'opencode',
  name: 'operation-identity-plugin',
  sourceUrl: new URL('./operation-identity-plugin.js', import.meta.url),
});

export interface MaterializedOpenCodePlugin {
  readonly url: string;
  close(): void;
}

export async function materializeOpenCodeOperationIdentityPlugin(): Promise<MaterializedOpenCodePlugin> {
  const directory = await mkdtemp(path.join(tmpdir(), 'garcon-opencode-plugin-'));
  const pluginPath = path.join(directory, 'operation-identity-plugin.js');
  try {
    const sourceLocation = PLUGIN_SOURCE.startsWith('file:')
      ? new URL(PLUGIN_SOURCE)
      : PLUGIN_SOURCE;
    const source = await Bun.file(sourceLocation).text();
    await writeFile(pluginPath, source, 'utf8');
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let closed = false;
  return {
    url: pathToFileURL(pluginPath).href,
    close() {
      if (closed) return;
      closed = true;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
