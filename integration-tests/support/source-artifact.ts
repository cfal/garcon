import { fileURLToPath } from 'node:url';

export interface SourceArtifact {
  readonly repoRoot: string;
  readonly bunExecutable: string;
}

export const CURRENT_ARTIFACT: SourceArtifact = {
  repoRoot: fileURLToPath(new URL('../..', import.meta.url)),
  bunExecutable: process.execPath,
};
