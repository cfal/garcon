import { lstat, rm } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const integrationTestsRoot = path.join(repositoryRoot, "integration-tests");

async function findWorkspaceRoots() {
  const manifest = await Bun.file(
    path.join(repositoryRoot, "package.json"),
  ).json();
  const roots = new Set();

  for (const workspace of manifest.workspaces) {
    const packages = new Bun.Glob(`${workspace}/package.json`);
    for await (const packagePath of packages.scan({
      cwd: repositoryRoot,
      onlyFiles: true,
    })) {
      roots.add(path.dirname(path.join(repositoryRoot, packagePath)));
    }
  }

  return [...roots].sort();
}

async function hasNonIsolatedDependencies(workspaceRoot) {
  const manifest = await Bun.file(
    path.join(workspaceRoot, "package.json"),
  ).json();
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  });

  for (const dependency of dependencies) {
    try {
      const entry = await lstat(
        path.join(workspaceRoot, "node_modules", dependency),
      );
      if (!entry.isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return false;
}

async function resetNonIsolatedDependencies(workspaceRoot) {
  if (!(await hasNonIsolatedDependencies(workspaceRoot))) {
    return;
  }

  console.log(
    `Resetting non-isolated dependencies in ${path.relative(repositoryRoot, workspaceRoot)}`,
  );
  await rm(path.join(workspaceRoot, "node_modules"), {
    recursive: true,
    force: true,
  });
}

async function installDependencies(installRoot) {
  const label = path.relative(repositoryRoot, installRoot) || "root workspace";
  console.log(`Installing dependencies in ${label}`);
  const install = Bun.spawn(
    [process.execPath, "install", "--frozen-lockfile"],
    {
      cwd: installRoot,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await install.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

const workspaceRoots = await findWorkspaceRoots();
await Promise.all(workspaceRoots.map(resetNonIsolatedDependencies));

const installRoots = [
  repositoryRoot,
  path.join(repositoryRoot, "server"),
  path.join(repositoryRoot, "web"),
  integrationTestsRoot,
];
for (const installRoot of installRoots) {
  await installDependencies(installRoot);
}
