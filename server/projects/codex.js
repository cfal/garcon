// Codex session reading. Handles JSONL sessions under ~/.codex/sessions/.

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

export const CODEX_SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

// Resolves a Codex JSONL path from a provider session ID by matching the
// filename suffix. Codex names files as `rollout-{timestamp}-{sessionId}.jsonl`,
// so a recursive glob for `*${sessionId}.jsonl` avoids reading every file.
export async function findCodexSessionFileBySessionId(sessionId) {
  if (!sessionId) {
    return null;
  }

  const suffix = `${sessionId}.jsonl`;
  const match = await findFileWithSuffix(CODEX_SESSIONS_ROOT, suffix);
  return match || null;
}

// Extracts session metadata from a Codex JSONL file path.
// Codex filenames follow: rollout-{timestamp}-{sessionId}.jsonl
export function getCodexSessionMeta(nativePath) {
  if (!nativePath) return null;
  const base = path.basename(nativePath, '.jsonl');
  // Extract the last segment after the last dash as session ID
  const lastDash = base.lastIndexOf('-');
  if (lastDash < 0) return { id: base };
  return { id: base.slice(lastDash + 1) };
}

async function findFileWithSuffix(dir, suffix) {
  if (!dir || !suffix) {
    return null;
  }

  if (typeof Bun !== 'undefined' && typeof Bun.Glob === 'function') {
    try {
      const escapedSuffix = suffix
        .replace(/\\/g, '\\\\')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\*/g, '\\*')
        .replace(/\?/g, '\\?');
      const glob = new Bun.Glob(`**/*${escapedSuffix}`);
      for await (const filePath of glob.scan({
        cwd: dir,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        return filePath;
      }
      return null;
    } catch {
      return null;
    }
  }

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const found = await findFileWithSuffix(fullPath, suffix);
      if (found) return found;
    } else if (entry.name.endsWith(suffix)) {
      return fullPath;
    }
  }
  return null;
}
