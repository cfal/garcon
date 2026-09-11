import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const defaultRepositoryRoot = join(import.meta.dir, "..");
const checksumLength = 12;
const generatedIconPattern =
  /^(?:favicon|icon|favicon-16x16|favicon-32x32|apple-touch-icon|icon-192|icon-512|icon-maskable-512)\.[a-f0-9]{12}\.(?:ico|svg|png)$/;
const appShellIconIds = [
  "favicon-ico",
  "icon-svg",
  "favicon-16",
  "favicon-32",
  "apple-touch",
] as const;

async function render(source: string, size: number): Promise<Uint8Array> {
  const process = Bun.spawn({
    cmd: ["rsvg-convert", "--width", String(size), "--height", String(size)],
    stdin: new Blob([source]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [bytes, error, exitCode] = await Promise.all([
    new Response(process.stdout).bytes(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(error.trim() || `Failed to render ${size}px icon.`);
  return bytes;
}

function createIco(
  images: readonly { size: number; bytes: Uint8Array }[],
): Uint8Array {
  const headerSize = 6 + images.length * 16;
  const totalSize =
    headerSize + images.reduce((total, image) => total + image.bytes.length, 0);
  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, images.length, true);
  let offset = headerSize;
  images.forEach((image, index) => {
    const entry = 6 + index * 16;
    output[entry] = image.size === 256 ? 0 : image.size;
    output[entry + 1] = image.size === 256 ? 0 : image.size;
    view.setUint16(entry + 4, 1, true);
    view.setUint16(entry + 6, 32, true);
    view.setUint32(entry + 8, image.bytes.length, true);
    view.setUint32(entry + 12, offset, true);
    output.set(image.bytes, offset);
    offset += image.bytes.length;
  });
  return output;
}

function checksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, checksumLength);
}

function normalizeSvg(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

interface GeneratedAsset {
  id: string;
  filename: string;
  bytes: Uint8Array;
}

function asset(
  id: string,
  stem: string,
  extension: string,
  bytes: Uint8Array,
): GeneratedAsset {
  return {
    id,
    filename: `${stem}.${checksum(bytes)}.${extension}`,
    bytes,
  };
}

function replaceMarkedLinkHref(
  html: string,
  id: string,
  href: string,
): string {
  const marker = `data-garcon-icon="${id}"`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1 || html.indexOf(marker, markerIndex + marker.length) !== -1) {
    throw new Error(`Expected exactly one app icon marker for ${id}.`);
  }
  const tagStart = html.lastIndexOf("<link", markerIndex);
  const tagEnd = html.indexOf(">", markerIndex);
  if (tagStart === -1 || tagEnd === -1) {
    throw new Error(`Invalid app icon link marker for ${id}.`);
  }
  const tag = html.slice(tagStart, tagEnd + 1);
  if (!/href="[^"]+"/.test(tag)) {
    throw new Error(`App icon link ${id} has no href.`);
  }
  const updatedTag = tag.replace(/href="[^"]+"/, `href="${href}"`);
  return `${html.slice(0, tagStart)}${updatedTag}${html.slice(tagEnd + 1)}`;
}

async function writeAtomically(
  targetPath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents);
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function generateBrandAssets(
  repositoryRoot = defaultRepositoryRoot,
  renderSvg = render,
): Promise<void> {
  const brandDirectory = join(repositoryRoot, "docs", "brand");
  const staticDirectory = join(repositoryRoot, "web", "static");
  const iconDirectory = join(staticDirectory, "icons");
  const sourceAssetDirectory = join(repositoryRoot, "web", "src", "lib", "assets");
  const appShellPath = join(repositoryRoot, "web", "src", "app.html");
  const manifestPath = join(staticDirectory, "site.webmanifest");

  const [rawCarbon, rawMaskable, originalAppShell, manifestText] =
    await Promise.all([
      Bun.file(join(brandDirectory, "garcon-fork-tail-carbon.svg")).text(),
      Bun.file(
        join(brandDirectory, "garcon-fork-tail-carbon-maskable.svg"),
      ).text(),
      Bun.file(appShellPath).text(),
      Bun.file(manifestPath).text(),
    ]);
  const carbon = normalizeSvg(rawCarbon);
  const maskable = normalizeSvg(rawMaskable);

  let appShellTemplate = originalAppShell;
  for (const id of appShellIconIds) {
    appShellTemplate = replaceMarkedLinkHref(
      appShellTemplate,
      id,
      `/icons/__${id}__`,
    );
  }
  const parsedManifest: unknown = JSON.parse(manifestText);
  if (
    !parsedManifest ||
    typeof parsedManifest !== "object" ||
    Array.isArray(parsedManifest)
  ) {
    throw new Error("Web app manifest must be a JSON object.");
  }

  if (renderSvg === render && !Bun.which("rsvg-convert")) {
    throw new Error(
      "rsvg-convert is required. Install librsvg and run this command again.",
    );
  }

  const faviconImages = await Promise.all(
    [16, 32, 48].map(async (size) => ({
      size,
      bytes: await renderSvg(carbon, size),
    })),
  );
  const assets = [
    asset("favicon-ico", "favicon", "ico", createIco(faviconImages)),
    asset("icon-svg", "icon", "svg", new TextEncoder().encode(carbon)),
    asset("favicon-16", "favicon-16x16", "png", faviconImages[0].bytes),
    asset("favicon-32", "favicon-32x32", "png", faviconImages[1].bytes),
    asset(
      "apple-touch",
      "apple-touch-icon",
      "png",
      await renderSvg(maskable, 180),
    ),
    asset("icon-192", "icon-192", "png", await renderSvg(carbon, 192)),
    asset("icon-512", "icon-512", "png", await renderSvg(carbon, 512)),
    asset(
      "icon-maskable-512",
      "icon-maskable-512",
      "png",
      await renderSvg(maskable, 512),
    ),
  ];
  const assetsById = new Map(assets.map((entry) => [entry.id, entry]));
  const href = (id: string): string => {
    const entry = assetsById.get(id);
    if (!entry) throw new Error(`Missing generated icon asset ${id}.`);
    return `/icons/${entry.filename}`;
  };

  let appShell = appShellTemplate;
  for (const id of appShellIconIds) {
    appShell = replaceMarkedLinkHref(appShell, id, href(id));
  }
  const manifest = { ...(parsedManifest as Record<string, unknown>) };
  manifest.icons = [
    { src: href("icon-192"), sizes: "192x192", type: "image/png" },
    { src: href("icon-512"), sizes: "512x512", type: "image/png" },
    {
      src: href("icon-maskable-512"),
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ];
  const serializedManifest = `${JSON.stringify(manifest, null, "\t")}\n`;
  const expectedFilenames = new Set(assets.map(({ filename }) => filename));

  await mkdir(iconDirectory, { recursive: true });
  await Promise.all([
    writeAtomically(join(sourceAssetDirectory, "favicon.svg"), carbon),
    ...assets.map(({ filename, bytes }) =>
      writeAtomically(join(iconDirectory, filename), bytes),
    ),
  ]);
  await writeAtomically(appShellPath, appShell);
  await writeAtomically(manifestPath, serializedManifest);

  for (const filename of await readdir(iconDirectory)) {
    if (generatedIconPattern.test(filename) && !expectedFilenames.has(filename)) {
      await unlink(join(iconDirectory, filename));
    }
  }

  console.log("Generated checksum-addressed browser and PWA icon assets.");
}

if (import.meta.main) {
  await generateBrandAssets();
}
