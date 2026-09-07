import { assertWebBuildCurrent } from '../../scripts/web-build-cache.js';

let currentBuild: Promise<void> | null = null;

export function requireCurrentWebBuild(): Promise<void> {
  const build = currentBuild ?? assertWebBuildCurrent();
  currentBuild = build;
  return build;
}
