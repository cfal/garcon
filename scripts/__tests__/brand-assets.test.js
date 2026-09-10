import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..", "..");
const read = (relativePath) =>
  readFile(path.join(repositoryRoot, relativePath));
const readText = async (relativePath) =>
  (await read(relativePath)).toString("utf8");

function pngSize(bytes) {
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

describe("Garcon brand assets", () => {
  test("ships the documented Carbon master as the stable SVG icon", async () => {
    const [master, staticIcon, sourceIcon] = await Promise.all([
      read("docs/brand/garcon-fork-tail-carbon.svg"),
      read("web/static/icon.svg"),
      read("web/src/lib/assets/favicon.svg"),
    ]);
    expect(staticIcon).toEqual(master);
    expect(sourceIcon).toEqual(master);
  });

  test("ships exact raster sizes for browser and installable-app consumers", async () => {
    for (const [relativePath, size] of [
      ["web/static/favicon-16x16.png", 16],
      ["web/static/favicon-32x32.png", 32],
      ["web/static/apple-touch-icon.png", 180],
      ["web/static/icon-192.png", 192],
      ["web/static/icon-512.png", 512],
      ["web/static/icon-maskable-512.png", 512],
    ]) {
      expect(pngSize(await read(relativePath))).toEqual({
        width: size,
        height: size,
      });
    }
  });

  test("uses the full-bleed Carbon export only for the maskable manifest entry", async () => {
    const manifest = JSON.parse(await readText("web/static/site.webmanifest"));
    expect(manifest.theme_color).toBe("#111827");
    expect(manifest.icons).toContainEqual({
      src: "/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    });
    expect(
      manifest.icons.filter((icon) => icon.purpose === "maskable"),
    ).toHaveLength(1);
  });

  test("defines Ink and Silver brand tokens for every application theme", async () => {
    for (const name of ["phosphor", "classic", "colorblind"]) {
      const [light, dark] = await Promise.all([
        readText(`web/src/lib/theme/profiles/${name}-light.css`),
        readText(`web/src/lib/theme/profiles/${name}-dark.css`),
      ]);
      expect(light).toContain("--brand-mark-surface: 0 0% 85%");
      expect(light).toContain("--brand-mark-foreground: 0 0% 7%");
      expect(dark).toContain("--brand-mark-surface: 0 0% 15%");
      expect(dark).toContain("--brand-mark-foreground: 0 0% 100%");
    }
  });
});
