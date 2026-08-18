export const GIT_REF_KINDS = ['local-branch', 'remote-branch', 'tag', 'other'] as const;
export type GitRefKind = (typeof GIT_REF_KINDS)[number];

export const GIT_REF_SORT_KEYS = ['name', 'updated'] as const;
export type GitRefSortKey = (typeof GIT_REF_SORT_KEYS)[number];

export const GIT_REF_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type GitRefSortDirection = (typeof GIT_REF_SORT_DIRECTIONS)[number];

export interface GitRefSort {
  readonly key: GitRefSortKey;
  readonly direction: GitRefSortDirection;
}

export const DEFAULT_GIT_REF_SORT: Readonly<GitRefSort> = Object.freeze({
  key: 'name',
  direction: 'asc',
});

export const GIT_REF_RESULT_LIMITS = Object.freeze({
  default: 200,
  max: 500,
});

export interface GitRefOption {
  name: string;
  ref: string;
  kind: GitRefKind;
  updatedAt: string | null;
  isCurrent?: boolean;
}

export interface GitRefsResponse {
  refs: GitRefOption[];
}

export function isGitRefKind(value: unknown): value is GitRefKind {
  return GIT_REF_KINDS.includes(value as GitRefKind);
}

export function parseGitRefSort(key: unknown, direction: unknown): GitRefSort | null {
  const keyMissing = key === null || key === undefined;
  const directionMissing = direction === null || direction === undefined;
  if (keyMissing && directionMissing) return { ...DEFAULT_GIT_REF_SORT };
  if (
    !GIT_REF_SORT_KEYS.includes(key as GitRefSortKey) ||
    !GIT_REF_SORT_DIRECTIONS.includes(direction as GitRefSortDirection)
  ) {
    return null;
  }
  return {
    key: key as GitRefSortKey,
    direction: direction as GitRefSortDirection,
  };
}
