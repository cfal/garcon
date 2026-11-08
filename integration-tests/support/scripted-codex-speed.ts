import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IntegrationDirectories } from './integration-fixture.js';
import type { ScriptedCodexTestEnvironment } from './scripted-codex.js';

export async function prepareScriptedCodexSpeed(
  environment: ScriptedCodexTestEnvironment,
  directories: IntegrationDirectories,
): Promise<void> {
  await environment.prepareWorkspace(directories);
  const catalogPath = join(directories.home, '.codex', 'live-models.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8')) as { models: Array<Record<string, unknown>> };
  for (const model of catalog.models) {
    model.service_tiers = [{ id: 'priority', name: 'Fast', description: 'Scripted Fast mode' }];
  }
  await writeFile(catalogPath, JSON.stringify(catalog));
  const configPath = join(directories.home, '.codex', 'config.toml');
  const config = await readFile(configPath, 'utf8');
  // Garcon Standard must override an executor-wide Fast default.
  await writeFile(configPath, `service_tier = "fast"\n${config}`);
}
