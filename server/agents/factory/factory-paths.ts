import os from 'os';
import path from 'path';

export function getFactoryBaseHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.FACTORY_HOME_OVERRIDE?.trim();
  return override || os.homedir();
}

export function getFactoryHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getFactoryBaseHome(env), '.factory');
}

export function getFactorySettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getFactoryHome(env), 'settings.json');
}

export function getFactorySessionDiscoveryIndexPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getFactoryHome(env), 'cache', 'session-discovery-index.json');
}

export function getFactorySessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getFactoryHome(env), 'sessions');
}

export function getFactoryAuthPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = getFactoryHome(env);
  return [
    path.join(home, 'auth.json'),
    path.join(home, 'auth.v2.file'),
    path.join(home, 'auth.v2.key'),
  ];
}
