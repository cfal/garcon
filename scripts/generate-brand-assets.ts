import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const repositoryRoot = join(import.meta.dir, "..");
const brandDirectory = join(repositoryRoot, "docs", "brand");
const staticDirectory = join(repositoryRoot, "web", "static");
const carbon = await Bun.file(
  join(brandDirectory, "garcon-fork-tail-carbon.svg"),
).text();
const maskable = await Bun.file(
  join(brandDirectory, "garcon-fork-tail-carbon-maskable.svg"),
).text();

if (!Bun.which("rsvg-convert")) {
  throw new Error(
    "rsvg-convert is required. Install librsvg and run this command again.",
  );
}

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

await mkdir(staticDirectory, { recursive: true });
await Bun.write(join(staticDirectory, "icon.svg"), carbon);

const faviconImages = await Promise.all(
  [16, 32, 48].map(async (size) => ({
    size,
    bytes: await render(carbon, size),
  })),
);
await Bun.write(
  join(staticDirectory, "favicon-16x16.png"),
  faviconImages[0].bytes,
);
await Bun.write(
  join(staticDirectory, "favicon-32x32.png"),
  faviconImages[1].bytes,
);
await Bun.write(join(staticDirectory, "favicon.ico"), createIco(faviconImages));
await Bun.write(
  join(staticDirectory, "icon-192.png"),
  await render(carbon, 192),
);
await Bun.write(
  join(staticDirectory, "icon-512.png"),
  await render(carbon, 512),
);
await Bun.write(
  join(staticDirectory, "apple-touch-icon.png"),
  await render(maskable, 180),
);
await Bun.write(
  join(staticDirectory, "icon-maskable-512.png"),
  await render(maskable, 512),
);

console.log("Generated Carbon web, favicon, touch, and maskable assets.");
