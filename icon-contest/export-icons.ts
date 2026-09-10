import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const contestDir = import.meta.dir;
const candidate = (Bun.argv[2] ?? "").replace(/\.svg$/, "");

if (!/^\d{2}-[a-z0-9-]+$/.test(candidate)) {
  throw new Error("Usage: bun icon-contest/export-icons.ts <candidate-name> [output-directory]");
}

const sourcePath = join(contestDir, "candidates", `${candidate}.svg`);
const source = await Bun.file(sourcePath).text();
if (!source.includes('<rect width="256" height="256" rx="52" fill="#2563eb"/>')) {
  throw new Error(`Candidate not found or does not match the icon contract: ${candidate}`);
}

const outputDir = Bun.argv[3] ?? join(contestDir, "exports", candidate);
const maskableSource = source.replace('rx="52"', 'rx="0"');

if (!Bun.which("rsvg-convert")) {
  throw new Error("rsvg-convert is required. Install librsvg, then run this command again.");
}

async function render(svg: string, filename: string, size: number) {
  const child = Bun.spawn({
    cmd: ["rsvg-convert", "--width", String(size), "--height", String(size)],
    stdin: new Blob([svg]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [png, error, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(error.trim() || `Failed to render ${filename}`);
  await Bun.write(join(outputDir, filename), png);
}

await mkdir(outputDir, { recursive: true });
await Bun.write(join(outputDir, "icon.svg"), source);

for (const size of [16, 32, 64]) {
  await render(source, `icon-${size}.png`, size);
}

await render(maskableSource, "apple-touch-icon-180.png", 180);
for (const size of [192, 512]) {
  await render(source, `pwa-${size}.png`, size);
  await render(maskableSource, `maskable-${size}.png`, size);
}

console.log(`Exported ${candidate} to ${outputDir}`);
