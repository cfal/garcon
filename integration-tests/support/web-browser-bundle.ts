import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = fileURLToPath(new URL("../../web/", import.meta.url));

export async function buildWebBrowserEntry(
  entrypoint: string,
): Promise<string> {
  const outputDirectory = await mkdtemp(
    join(tmpdir(), "garcon-web-browser-bundle-"),
  );
  const outputPath = join(outputDirectory, "bundle.js");
  try {
    const build = Bun.spawn(
      [
        "bun",
        "build",
        entrypoint,
        "--target=browser",
        "--format=esm",
        `--outfile=${outputPath}`,
      ],
      {
        cwd: WEB_ROOT,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(stderr);
    }
    return readFile(outputPath, "utf8");
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
