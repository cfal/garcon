// Node paths use forward slashes; POSIX filename backslashes remain literal.
export type NodePath = string;

export function isWithinNodePath(root: NodePath, candidate: NodePath): boolean {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}
