import { assertRealWithinBase } from "../../../../server/common/path-boundary.js";
import { FilesService } from "../../../../server/runtime/files/service.js";
import { inspectProjectDirectory } from "../../../../server/runtime/projects/project-directory-service.js";
import { ProjectService } from "../../../../server/runtime/projects/project-service.js";
import { readFile } from "node:fs/promises";

if (Bun.version !== "1.4.3") throw new Error("Expected Bun 1.4.3");
const root = Bun.argv[2]!;
const command = Bun.argv[3]!;
const project = root + "/project";
const target = { projectPath: project, filePath: "stable.txt" };
const service = new FilesService({ executorId: "synthetic", projectBasePath: root,
  homeDirectory: project + "/folder" });
async function observed<T>(call: () => Promise<T>) {
  try {
    return { ok: await call() };
  } catch (error) {
    const { code, message, status, retryable } = error as { code: string; message: string; status: number; retryable: boolean };
    return { error: { code, message, status, retryable } };
  }
}

switch (command) {
  case "file": {
    const read = await service.read(target);
    console.log(JSON.stringify({
      read: { bytes: Buffer.from(read.bytes).toString("base64"), path: read.path, revision: read.revision },
      revision: await service.revision(target),
    }));
    break;
  }
  case "snapshot": {
    const read = await service.read(target);
    const inspect = (path: string) => inspectProjectDirectory(path, {
      resolvePath: (path) => assertRealWithinBase(root, path),
    });
    console.log(JSON.stringify({
      tree: await service.tree({ directoryPath: project }),
      browse: await service.browse({ directoryPath: project }),
      list: await service.list({ projectPath: project }),
      identity: await service.identity({ ...target, filePath: "alias.txt" }),
      read: { bytes: Buffer.from(read.bytes).toString("base64"), path: read.path, revision: read.revision },
      revision: await service.revision(target),
      missing: await service.revision({ ...target, filePath: "absent" }),
      loop: await observed(() => service.identity({ ...target, filePath: "loop-one" })),
      pipe: await observed(() => service.revision({ ...target, filePath: "named-pipe" })),
      outside: await observed(() => service.identity({ ...target, filePath: "escape" })),
      unreadable: await observed(() => service.list({ projectPath: project + "/private" })),
      inspect: await Promise.all(["", "project", "project/inside-link", "project/loop-one", "project/escape",
        "project/private", "project/stable.txt", "absent"].map(inspect)),
    }));
    break;
  }
  case "large": {
    const large = root + "/large";
    console.log(JSON.stringify({
      tree: await observed(() => service.tree({ directoryPath: large })),
      browse: await service.browse({ directoryPath: large }),
      list: await service.list({ projectPath: large }),
    }));
    break;
  }
  case "save": {
    const { content, expectedRevision } = JSON.parse(await readFile(Bun.argv[4]!, "utf8"));
    console.log(JSON.stringify(await observed(() => service.save({
      ...target, content, expectedRevision, conflictResolution: "reject",
    }))));
    break;
  }
  case "create": {
    console.log(JSON.stringify(await observed(() => service.createDirectory({
      parentPath: project + "/inside-link", name: "with spaces ",
    }))));
    break;
  }
  case "project": {
    const projects = new ProjectService(root, () => {});
    const linkedBase = new ProjectService(root + "/base-alias", () => {});
    const inspect = (path: string, includeGitRepository?: boolean) => projects.inspect({
      projectPath: path, includeGitRepository,
    });
    const prompt = await readFile(Bun.argv[4]!, "utf8");
    console.log(JSON.stringify({
      inspected: await Promise.all([
        inspect("project", true), inspect("project/inside-link"), inspect(root, true),
        linkedBase.inspect({ projectPath: project + "/folder" }),
      ]),
      resolved: await projects.resolveFileMentions({projectPath: project, command: prompt}),
    }));
    break;
  }
  case "ticket-defaults": {
    const projects = new ProjectService(root, () => {});
    const requests = JSON.parse(await readFile(Bun.argv[4]!, "utf8")) as string[];
    const results = [];
    for (const projectPath of requests) {
      results.push(await observed(() => projects.ticketProjectDefault({ projectPath })));
    }
    console.log(JSON.stringify(results));
    break;
  }
  default:
    throw new Error("Unknown filesystem oracle command");
}
