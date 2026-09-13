import {
  isExecutionIdentity, parseExecutionLocation, type ExecutionLocation,
} from '../../common/execution-location.js';
import { isStoredProjectPath } from '../../common/execution-nodes.js';
import type { ProviderRetainedExecutionService } from '../execution-nodes/provider-execution.js';
import type { WorkspaceFileService } from '../execution-nodes/workspace-files.js';
import { DomainError, ProjectUnavailableError } from '../lib/domain-error.js';

export const MAX_NODE_EXECUTION_RESOURCES = 4_096;

export interface NodeExecutionSourceTarget {
  readonly chatId: string;
  readonly location: ExecutionLocation;
  readonly projectPath: string;
}

export interface NodeExecutionResource {
  readonly location: ExecutionLocation;
  readonly projectPath: string;
  readonly execution: ProviderRetainedExecutionService | null;
  readonly files: Pick<WorkspaceFileService, 'inspectProject'>;
}

export interface PreparedNodeExecutionResource {
  readonly location: ExecutionLocation;
  readonly projectPath: string;
  readonly execution: ProviderRetainedExecutionService | null;
  /** Ends when this grant retires, independently of the preparation caller. */
  readonly signal: AbortSignal;
  validate(): void;
}

interface RegisteredResource {
  readonly resource: NodeExecutionResource;
  readonly cancellation: AbortController;
}

/** Holds host-installed grants; incoming requests select identities, never filesystem paths or services. */
export class NodeExecutionResources {
  readonly #resources = new Map<string, RegisteredResource>();
  #closed = false;

  constructor(private readonly nodeId: string) {
    if (!isExecutionIdentity(nodeId)) throw new TypeError('Invalid execution node identity');
  }

  register(input: NodeExecutionResource): void {
    if (this.#closed) throw unavailable();
    const location = this.#location(input.location);
    if (!isStoredProjectPath(input.projectPath)) throw new TypeError('Invalid execution resource path');
    const key = resourceKey(location);
    const existing = this.#resources.get(key);
    if (existing) {
      if (!existing.cancellation.signal.aborted) throw new TypeError('Execution resource is already registered');
      if (existing.resource.projectPath !== input.projectPath || existing.resource.execution !== input.execution
        || existing.resource.files !== input.files) {
        throw new TypeError('An execution resource identity cannot be rebound');
      }
    } else if (this.#resources.size >= MAX_NODE_EXECUTION_RESOURCES) {
      throw new DomainError('NODE_CAPACITY', 'Execution resource limit reached', 429);
    }
    this.#resources.set(key, {
      resource: Object.freeze({ ...input, location: Object.freeze(location) }),
      cancellation: new AbortController(),
    });
  }

  async prepare(input: ExecutionLocation, signal: AbortSignal): Promise<PreparedNodeExecutionResource> {
    signal.throwIfAborted();
    const location = this.#location(input);
    const key = resourceKey(location);
    const registered = this.#resources.get(key);
    if (this.#closed || !registered) throw unavailable();
    const validate = () => {
      if (this.#closed || this.#resources.get(key) !== registered) throw unavailable();
      registered.cancellation.signal.throwIfAborted();
    };
    validate();
    const preparationSignal = AbortSignal.any([signal, registered.cancellation.signal]);
    const resource = registered.resource;
    const project = await resource.files.inspectProject(resource.projectPath, preparationSignal);
    preparationSignal.throwIfAborted();
    validate();
    if (project.kind === 'unavailable') throw new ProjectUnavailableError(resource.projectPath, project.reason);
    if (!isStoredProjectPath(project.effectiveProjectKey)) throw new TypeError('Invalid resolved execution project');
    return Object.freeze({
      location: resource.location, projectPath: project.effectiveProjectKey, execution: resource.execution,
      signal: registered.cancellation.signal, validate,
    });
  }

  revoke(input: ExecutionLocation): void {
    const location = this.#location(input);
    this.#resources.get(resourceKey(location))?.cancellation.abort(unavailable());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const resource of this.#resources.values()) resource.cancellation.abort(unavailable());
  }

  #location(input: ExecutionLocation): ExecutionLocation {
    const location = parseExecutionLocation(input);
    if (!location || location.nodeId !== this.nodeId) throw unavailable();
    return location;
  }
}

function resourceKey(location: ExecutionLocation): string {
  return JSON.stringify([location.instanceId, location.workspaceId]);
}

function unavailable(): DomainError {
  return new DomainError('NODE_UNAVAILABLE', 'The execution resource grant is unavailable', 409);
}
