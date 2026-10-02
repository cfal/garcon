import { describe, it, expect } from "bun:test";
import { createGitOperations } from "../git-service.js";

describe("createGitOperations", () => {
  const git = createGitOperations();

  it("returns an object with all expected service methods", () => {
    const expectedMethods = [
      "getStatus",
      "initialCommit",
      "commit",
      "getBranches",
      "getRefs",
      "checkout",
      "createBranch",
      "getHistoryCommits",
      "getCommitSnapshot",
      "getComparisonSnapshot",
      "getRemoteStatus",
      "getRemotes",
      "fetch",
      "pull",
      "push",
      "discard",
      "deleteUntracked",
      "getWorkbenchSnapshot",
      "getWorkingTreeFingerprint",
      "getQuickSummary",
      "getReviewDocumentFileBodies",
      "stageSelection",
      "stageHunk",
      "getWorktrees",
      "getTargetCandidates",
      "createWorktree",
      "removeWorktree",
      "commitIndex",
      "stagePaths",
      "revertCommit",
      "getConflicts",
      "getConflictDetails",
      "acceptConflictSide",
      "markConflictResolved",
      "getStashes",
      "createStash",
      "applyStash",
      "popStash",
      "dropStash",
      "getFileHistory",
      "getBlame",
      "getGraph",
    ];
    for (const method of expectedMethods) {
      expect(typeof git[method]).toBe("function");
    }
    expect(git.stageFile).toBeUndefined();
  });
});
