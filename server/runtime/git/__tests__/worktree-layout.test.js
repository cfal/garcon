import { describe, expect, it } from "bun:test";
import { parseWorktreeLayoutProbe } from "../worktree-layout.js";

describe("worktree layout probe", () => {
  it("parses a trusted files-backend layout", () => {
    expect(
      parseWorktreeLayoutProbe("true\n/repo/worktree\n/repo/.git\nfiles\n"),
    ).toEqual({
      worktreeRoot: "/repo/worktree",
      commonDir: "/repo/.git",
      refFormat: "files",
    });
  });

  it("declines incomplete, relative, and non-worktree output", () => {
    expect(parseWorktreeLayoutProbe("true\n/repo\n/repo/.git\n")).toBeNull();
    expect(
      parseWorktreeLayoutProbe("true\nrepo\n/repo/.git\nfiles\n"),
    ).toBeNull();
    expect(
      parseWorktreeLayoutProbe("false\n/repo\n/repo/.git\nfiles\n"),
    ).toBeNull();
  });

  it("retains unsupported ref formats for the caller to route to Git", () => {
    expect(
      parseWorktreeLayoutProbe(
        "true\n/repo/worktree\n/repo/.git\nreftable\n",
      ),
    ).toMatchObject({ refFormat: "reftable" });
  });

  it("routes echoed probe flags from older Git versions to Git", () => {
    expect(
      parseWorktreeLayoutProbe(
        "true\n/repo\n/repo/.git\n--show-ref-format\n",
      ),
    ).toMatchObject({ refFormat: "--show-ref-format" });
    expect(
      parseWorktreeLayoutProbe(
        "true\n--path-format=absolute\n/repo\n/repo/.git\n--show-ref-format\n",
      ),
    ).toBeNull();
  });
});
