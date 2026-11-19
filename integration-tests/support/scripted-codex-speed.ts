import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationDirectories } from './integration-fixture.js';
import type { ScriptedCodexTestEnvironment } from './scripted-codex.js';

export const STANDARD_ONLY_MODEL = 'integration-standard-only';

export async function prepareScriptedCodexSpeed(
  environment: ScriptedCodexTestEnvironment, directories: IntegrationDirectories,
): Promise<void> {
  await environment.prepareWorkspace(directories);
  const home = join(directories.home, '.codex');
  const catalogPath = join(home, 'live-models.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { models: Array<Record<string, unknown>> };
  const model = catalog.models[0]!;
  catalog.models = [
    { ...model, service_tiers: [
      { id: 'priority', name: 'Express', description: 'Synthetic priority tier' },
      { id: 'ultrafast', name: 'Sprint', description: 'Synthetic ultrafast tier' },
    ] },
    { ...model, slug: STANDARD_ONLY_MODEL, service_tiers: [] },
  ];
  await writeFile(catalogPath, JSON.stringify(catalog));
  const config = join(home, 'config.toml');
  await writeFile(config, `service_tier = "ultrafast"\n${await readFile(config, 'utf8')}`);
}
