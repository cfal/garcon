import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { generateBrandAssets } from "../generate-brand-assets.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..", "..");
const iconDirectory = path.join(repositoryRoot, "web", "static", "icons");
const read = (relativePath) =>
  readFile(path.join(repositoryRoot, relativePath));
const readText = async (relativePath) =>
  (await read(relativePath)).toString("utf8");
const legacyAssetFilenames = [
  "favicon.000000000000.ico",
  "icon.000000000000.svg",
  "favicon-16x16.000000000000.png",
  "favicon-32x32.000000000000.png",
  "apple-touch-icon.000000000000.png",
  "icon-192.000000000000.png",
  "icon-512.000000000000.png",
  "icon-maskable-512.000000000000.png",
];
const validFixtureShell = [
  '<link data-garcon-icon="favicon-ico" rel="icon" href="/icons/favicon.000000000000.ico">',
  '<link data-garcon-icon="icon-svg" rel="icon" href="/icons/icon.000000000000.svg">',
  '<link data-garcon-icon="favicon-16" rel="icon" href="/icons/favicon-16x16.000000000000.png">',
  '<link data-garcon-icon="favicon-32" rel="icon" href="/icons/favicon-32x32.000000000000.png">',
  '<link data-garcon-icon="apple-touch" rel="apple-touch-icon" href="/icons/apple-touch-icon.000000000000.png">',
].join("\n");
const validFixtureManifest = JSON.stringify({
  name: "Garcon",
  icons: [
    { src: "/icons/icon-192.000000000000.png" },
    { src: "/icons/icon-512.000000000000.png" },
    { src: "/icons/icon-maskable-512.000000000000.png" },
  ],
});

async function createFailureFixture(appShell, manifest) {
  const root = await mkdtemp(path.join(os.tmpdir(), "garcon-brand-assets-"));
  const directories = [
    "docs/brand",
    "web/src/lib/assets",
    "web/static/icons",
  ];
  await Promise.all(
    directories.map((directory) => mkdir(path.join(root, directory), { recursive: true })),
  );
  await Promise.all([
    writeFile(
      path.join(root, "docs/brand/garcon-fork-tail-carbon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    ),
    writeFile(
      path.join(root, "docs/brand/garcon-fork-tail-carbon-maskable.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    ),
    writeFile(path.join(root, "web/src/app.html"), appShell),
    writeFile(path.join(root, "web/static/site.webmanifest"), manifest),
    ...legacyAssetFilenames.map((filename) =>
      writeFile(path.join(root, "web/static/icons", filename), filename),
    ),
  ]);
  return root;
}

async function expectLegacyAssetsIntact(root) {
  expect((await readdir(path.join(root, "web/static/icons"))).sort()).toEqual(
    [...legacyAssetFilenames].sort(),
  );
}

async function findAssetIn(directory, stem, extension) {
  const matches = (await readdir(directory)).filter(
    (filename) =>
      filename.startsWith(`${stem}.`) && filename.endsWith(`.${extension}`),
  );
  expect(matches).toHaveLength(1);
  return matches[0];
}

async function findAsset(stem, extension) {
  return findAssetIn(iconDirectory, stem, extension);
}

async function runGit(cwd, ...args) {
  const process = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [bytes, error, exitCode] = await Promise.all([
    new Response(process.stdout).bytes(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(error.trim());
  return bytes;
}

async function assetHref(stem, extension) {
  return `/icons/${await findAsset(stem, extension)}`;
}

function pngSize(bytes) {
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

describe("Garcon brand assets", () => {
  test("preserves referenced exports when app-shell validation fails", async () => {
    const invalidShell = validFixtureShell.replace(
      'data-garcon-icon="icon-svg"',
      'data-garcon-icon="invalid-icon-svg"',
    );
    const root = await createFailureFixture(invalidShell, validFixtureManifest);
    try {
      await expect(generateBrandAssets(root)).rejects.toThrow(
        "Expected exactly one app icon marker for icon-svg.",
      );
      expect(await readFile(path.join(root, "web/src/app.html"), "utf8")).toBe(
        invalidShell,
      );
      await expectLegacyAssetsIntact(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preserves consumers and referenced exports when manifest validation fails", async () => {
    const invalidManifest = '{"name":"Garcon","icons":';
    const root = await createFailureFixture(validFixtureShell, invalidManifest);
    try {
      await expect(generateBrandAssets(root)).rejects.toThrow();
      expect(await readFile(path.join(root, "web/src/app.html"), "utf8")).toBe(
        validFixtureShell,
      );
      expect(
        await readFile(path.join(root, "web/static/site.webmanifest"), "utf8"),
      ).toBe(invalidManifest);
      await expectLegacyAssetsIntact(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ships the documented Carbon master as the browser SVG icon", async () => {
    const [master, staticIcon, sourceIcon] = await Promise.all([
      read("docs/brand/garcon-fork-tail-carbon.svg"),
      read(`web/static/icons/${await findAsset("icon", "svg")}`),
      read("web/src/lib/assets/favicon.svg"),
    ]);
    const normalizedMaster = Buffer.from(
      master.toString("utf8").replace(/\r\n?/g, "\n"),
    );
    const normalizedSourceIcon = Buffer.from(
      sourceIcon.toString("utf8").replace(/\r\n?/g, "\n"),
    );
    expect(staticIcon).toEqual(normalizedMaster);
    expect(normalizedSourceIcon).toEqual(normalizedMaster);
  });

  test("embeds each asset checksum in its filename", async () => {
    const filenames = await readdir(iconDirectory);
    expect(filenames).toHaveLength(8);
    for (const filename of filenames) {
      const match = filename.match(/\.([a-f0-9]{12})\.[^.]+$/);
      expect(match).not.toBeNull();
      const bytes = await readFile(path.join(iconDirectory, filename));
      const actual = createHash("sha256").update(bytes).digest("hex");
      expect(actual.startsWith(match[1])).toBe(true);
      expect(filename).not.toMatch(/carbon|forest|ink|silver|\.v\d/i);
    }
  });

  test("normalizes CRLF masters before hashing generated SVGs", async () => {
    const root = await createFailureFixture(
      validFixtureShell,
      validFixtureManifest,
    );
    const crlfSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">',
      '<rect width="64" height="64"/>',
      "</svg>",
      "",
    ].join("\r\n");
    try {
      await Promise.all([
        writeFile(
          path.join(root, ".gitattributes"),
          await read(".gitattributes"),
        ),
        writeFile(
          path.join(root, "docs/brand/garcon-fork-tail-carbon.svg"),
          crlfSvg,
        ),
        writeFile(
          path.join(root, "docs/brand/garcon-fork-tail-carbon-maskable.svg"),
          crlfSvg,
        ),
      ]);
      const renderedSources = [];
      await generateBrandAssets(root, async (source, size) => {
        renderedSources.push(source);
        return new TextEncoder().encode(`${size}:${source}`);
      });

      const fixtureIconDirectory = path.join(root, "web/static/icons");
      const filename = await findAssetIn(fixtureIconDirectory, "icon", "svg");
      const bytes = await readFile(path.join(fixtureIconDirectory, filename));
      expect(bytes.includes(13)).toBe(false);
      const actual = createHash("sha256").update(bytes).digest("hex");
      expect(filename).toContain(`.${actual.slice(0, 12)}.`);
      expect(
        await readFile(path.join(root, "web/src/lib/assets/favicon.svg")),
      ).toEqual(bytes);
      expect(renderedSources).toHaveLength(7);
      expect(renderedSources.every((source) => !source.includes("\r"))).toBe(true);

      await runGit(root, "init", "--quiet");
      await runGit(
        root,
        "-c",
        "core.autocrlf=true",
        "add",
        ".gitattributes",
        "docs/brand/garcon-fork-tail-carbon.svg",
        `web/static/icons/${filename}`,
      );
      const filteredBytes = await runGit(
        root,
        "-c",
        "core.autocrlf=true",
        "cat-file",
        "--filters",
        `:web/static/icons/${filename}`,
      );
      const filteredChecksum = createHash("sha256")
        .update(filteredBytes)
        .digest("hex");
      expect(filename).toContain(`.${filteredChecksum.slice(0, 12)}.`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("filters the working-tree SVG without depending on HEAD", async () => {
    const filename = await findAsset("icon", "svg");
    const root = await mkdtemp(path.join(os.tmpdir(), "garcon-brand-git-"));
    try {
      const fixtureIconRelativePath = `web/static/icons/${filename}`;
      const fixtureIconPath = path.join(root, fixtureIconRelativePath);
      await mkdir(path.dirname(fixtureIconPath), { recursive: true });
      await Promise.all([
        writeFile(
          path.join(root, ".gitattributes"),
          await read(".gitattributes"),
        ),
        writeFile(fixtureIconPath, await read(`web/static/icons/${filename}`)),
      ]);
      await runGit(root, "init", "--quiet");
      await runGit(
        root,
        "-c",
        "core.autocrlf=true",
        "add",
        ".gitattributes",
        fixtureIconRelativePath,
      );

      const bytes = await runGit(
        root,
        "-c",
        "core.autocrlf=true",
        "cat-file",
        "--filters",
        `:${fixtureIconRelativePath}`,
      );
      const actual = createHash("sha256").update(bytes).digest("hex");
      expect(filename).toContain(`.${actual.slice(0, 12)}.`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ships exact raster sizes for browser and installable-app consumers", async () => {
    for (const [stem, size] of [
      ["favicon-16x16", 16],
      ["favicon-32x32", 32],
      ["apple-touch-icon", 180],
      ["icon-192", 192],
      ["icon-512", 512],
      ["icon-maskable-512", 512],
    ]) {
      const filename = await findAsset(stem, "png");
      expect(pngSize(await readFile(path.join(iconDirectory, filename)))).toEqual({
        width: size,
        height: size,
      });
    }
  });

  test("uses the full-bleed export only for the maskable manifest entry", async () => {
    const manifest = JSON.parse(await readText("web/static/site.webmanifest"));
    expect(manifest.theme_color).toBe("#111827");
    expect(manifest.icons).toContainEqual({
      src: await assetHref("icon-maskable-512", "png"),
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    });
    expect(
      manifest.icons.filter((icon) => icon.purpose === "maskable"),
    ).toHaveLength(1);
  });

  test("references each checksum-addressed browser asset from the app shell", async () => {
    const shell = await readText("web/src/app.html");
    for (const [id, stem, extension] of [
      ["favicon-ico", "favicon", "ico"],
      ["icon-svg", "icon", "svg"],
      ["favicon-16", "favicon-16x16", "png"],
      ["favicon-32", "favicon-32x32", "png"],
      ["apple-touch", "apple-touch-icon", "png"],
    ]) {
      expect(shell).toContain(`data-garcon-icon="${id}"`);
      expect(shell).toContain(`href="${await assetHref(stem, extension)}"`);
    }
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
