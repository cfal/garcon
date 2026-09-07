import path from "node:path";
import { promises as fs, type Stats } from "node:fs";
import { mapWithConcurrencyResult } from "../lib/concurrency.js";
import type { WorktreeLayout } from "./worktree-layout.js";
import type { WorktreeRecord } from "./worktree-record.js";

const WORKTREE_ADMIN_READ_CONCURRENCY = 32;
const MAX_SYMREF_DEPTH = 8;
const TRAILING_WHITESPACE = /[ \t\n\v\f\r]+$/;
const LEADING_WHITESPACE = /^[ \t\n\v\f\r]+/;
const DIRECT_HEAD = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const CORE_BARE_SETTING = /^\s*bare(?:\s*=\s*(.*?))?\s*$/i;
const USE_GIT_FALLBACK = Symbol("use-git-fallback");
const FALSE_GIT_BOOLEANS = new Set(["false", "no", "off", "0", ""]);

type HeadFields = Pick<WorktreeRecord, "branch" | "name">;
type HeadReadResult = HeadFields | typeof USE_GIT_FALLBACK;
type LinkedWorktreeReadResult =
  | WorktreeRecord
  | null
  | typeof USE_GIT_FALLBACK;

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function realpathForgiving(filePath: string): Promise<string> {
  const unresolved: string[] = [];
  let candidate = filePath;
  while (true) {
    try {
      return path.join(await fs.realpath(candidate), ...unresolved);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) return filePath;
      unresolved.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function readAdminEntries(worktreesDir: string): Promise<string[]> {
  try {
    return await fs.readdir(worktreesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function stripGitDirSuffix(filePath: string): string {
  return /[\\/]\.git$/.test(filePath) ? filePath.slice(0, -5) : filePath;
}

function trimGitFile(content: string | null): string {
  return (content ?? "").replace(TRAILING_WHITESPACE, "");
}

function fieldsForRef(ref: string): HeadFields {
  const branch = ref.startsWith("refs/heads/")
    ? ref.substring("refs/heads/".length)
    : ref;
  return { branch, name: branch };
}

function gitBooleanIsEnabled(rawValue: string | undefined): boolean {
  const value = (rawValue ?? "true")
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .toLowerCase();
  return !FALSE_GIT_BOOLEANS.has(value);
}

function configRequiresGitFallback(content: string | null): boolean {
  if (content === null) return true;

  let section = "";
  for (const rawLine of content.split("\n")) {
    let line = rawLine.replace(/\s*[#;].*$/, "");
    const sectionMatch = line.match(/^\s*\[\s*([a-z0-9.-]+)/i);
    if (sectionMatch) {
      section = sectionMatch[1]?.toLowerCase() ?? "";
      if (section === "include" || section === "includeif") return true;
      const sectionEnd = line.indexOf("]");
      if (sectionEnd === -1) return true;
      line = line.slice(sectionEnd + 1);
    }

    const bareSetting = section === "core"
      ? line.match(CORE_BARE_SETTING)
      : null;
    if (bareSetting && gitBooleanIsEnabled(bareSetting[1])) return true;
  }
  return false;
}

function resolveAdminRefPath(commonDir: string, ref: string): string | null {
  if (!ref.startsWith("refs/")) return null;
  const refPath = path.resolve(commonDir, ref);
  const relative = path.relative(commonDir, refPath);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  return refPath;
}

async function resolveHeadFields(
  commonDir: string,
  content: string | null,
  worktreePath: string,
): Promise<HeadReadResult> {
  let head = trimGitFile(content);
  if (!head.startsWith("ref:")) {
    if (DIRECT_HEAD.test(head)) {
      return { branch: "(detached)", name: path.basename(worktreePath) };
    }
    return { branch: "", name: path.basename(worktreePath) };
  }

  let ref = head.substring(4).replace(LEADING_WHITESPACE, "");
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_SYMREF_DEPTH; depth += 1) {
    if (!ref || seen.has(ref)) return USE_GIT_FALLBACK;
    seen.add(ref);

    const refPath = resolveAdminRefPath(commonDir, ref);
    if (refPath === null) return USE_GIT_FALLBACK;
    const [refContent, refStats] = await Promise.all([
      readTextOrNull(refPath),
      lstatOrNull(refPath),
    ]);
    if (refStats?.isSymbolicLink()) return USE_GIT_FALLBACK;

    head = trimGitFile(refContent);
    if (!head.startsWith("ref:")) return fieldsForRef(ref);
    ref = head.substring(4).replace(LEADING_WHITESPACE, "");
  }
  return USE_GIT_FALLBACK;
}

async function readLinkedWorktree(
  commonDir: string,
  adminDir: string,
): Promise<LinkedWorktreeReadResult> {
  const headPath = path.join(adminDir, "HEAD");
  const [gitdirContent, headContent, headStats] = await Promise.all([
    readTextOrNull(path.join(adminDir, "gitdir")),
    readTextOrNull(headPath),
    lstatOrNull(headPath),
  ]);
  if (gitdirContent === null) return null;
  if (headStats?.isSymbolicLink()) return USE_GIT_FALLBACK;

  const gitdir = trimGitFile(gitdirContent);
  if (!gitdir) {
    return gitdirContent.length === 0 ? null : USE_GIT_FALLBACK;
  }

  const storedPath = stripGitDirSuffix(gitdir);
  const worktreePath = path.isAbsolute(storedPath)
    ? storedPath
    : await realpathForgiving(path.resolve(adminDir, storedPath));
  const headFields = await resolveHeadFields(
    commonDir,
    headContent,
    worktreePath,
  );
  if (headFields === USE_GIT_FALLBACK) return headFields;
  return {
    path: worktreePath,
    ...headFields,
    isMain: false,
  };
}

export async function readAdminWorktreeRecords(
  layout: WorktreeLayout,
): Promise<WorktreeRecord[] | null> {
  const commonDir = await fs.realpath(layout.commonDir);
  if (path.basename(commonDir) !== ".git") return null;

  const mainPath = path.dirname(commonDir);
  const worktreesDir = path.join(commonDir, "worktrees");
  const mainHeadPath = path.join(commonDir, "HEAD");
  const [
    mainHead,
    mainHeadStats,
    repositoryConfig,
    worktreeConfigStats,
    adminEntries,
  ] = await Promise.all([
    readTextOrNull(mainHeadPath),
    lstatOrNull(mainHeadPath),
    readTextOrNull(path.join(commonDir, "config")),
    lstatOrNull(path.join(commonDir, "config.worktree")),
    readAdminEntries(worktreesDir),
  ]);
  if (
    mainHeadStats?.isSymbolicLink() ||
    worktreeConfigStats !== null ||
    configRequiresGitFallback(repositoryConfig)
  ) {
    return null;
  }
  const mainHeadFields = await resolveHeadFields(commonDir, mainHead, mainPath);
  if (mainHeadFields === USE_GIT_FALLBACK) return null;

  const linkedResults = await mapWithConcurrencyResult(
    adminEntries,
    WORKTREE_ADMIN_READ_CONCURRENCY,
    (entry) => readLinkedWorktree(commonDir, path.join(worktreesDir, entry)),
  );
  const linkedRecords: WorktreeRecord[] = [];
  for (const result of linkedResults) {
    if (result === USE_GIT_FALLBACK) return null;
    if (result !== null) linkedRecords.push(result);
  }

  return [
    {
      path: mainPath,
      ...mainHeadFields,
      isMain: true,
    },
    ...linkedRecords,
  ];
}
