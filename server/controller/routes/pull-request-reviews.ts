import type {
  PullRequestReviewMutationResponse,
  PullRequestReviewRunMutationResponse,
  PullRequestReviewRunsResponse,
} from '../../../common/pull-request-reviews.js';
import { jsonErrorFromUnknown } from '../../common/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { reviewInvalid } from '../pull-request-reviews/errors.js';
import type { PullRequestReviewsRuntime } from '../pull-request-reviews/setup.js';

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw reviewInvalid(`${field} is required`);
  return value;
}

function requiredNumber(value: unknown): number {
  const number = typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw reviewInvalid('number is required');
  return number;
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw reviewInvalid('A JSON object is required');
  return value as Record<string, unknown>;
}

export default function createPullRequestReviewRoutes(reviews: PullRequestReviewsRuntime): RouteMap {
  function mutation(): PullRequestReviewMutationResponse {
    return { success: true, snapshot: reviews.service.snapshot() };
  }

  async function guarded(operation: () => Promise<Response> | Response): Promise<Response> {
    try { return await operation(); }
    catch (error) { return jsonErrorFromUnknown(error); }
  }

  return {
    '/api/v1/pull-request-reviews': {
      GET: () => guarded(() => Response.json(reviews.service.snapshot())),
    },
    '/api/v1/pull-request-reviews/repositories': {
      POST: withJsonBody((raw) => guarded(async () => {
        const repository = await reviews.service.connect(body(raw));
        return Response.json({ ...mutation(), repository }, { status: 201 });
      })),
      PUT: withJsonBody((raw) => guarded(async () => {
        const request = body(raw);
        const repository = await reviews.service.update(requiredId(request.id, 'id'), request.repository);
        return Response.json({ ...mutation(), repository });
      })),
      DELETE: withJsonBody((raw) => guarded(() => {
        reviews.service.remove(requiredId(body(raw).id, 'id'));
        return Response.json(mutation());
      })),
    },
    '/api/v1/pull-request-reviews/scan': {
      POST: withJsonBody((raw) => guarded(() => {
        const request = body(raw);
        reviews.service.scan(request.repositoryId === undefined ? undefined : requiredId(request.repositoryId, 'repositoryId'));
        return Response.json({ success: true }, { status: 202 });
      })),
    },
    '/api/v1/pull-request-reviews/runs': {
      GET: (_request, url) => guarded(() => Response.json({
        runs: reviews.service.runs(requiredId(url.searchParams.get('repositoryId'), 'repositoryId'), requiredNumber(url.searchParams.get('number'))),
      } satisfies PullRequestReviewRunsResponse)),
      POST: withJsonBody((raw) => guarded(() => {
        const request = body(raw);
        const run = reviews.service.review(requiredId(request.repositoryId, 'repositoryId'), requiredNumber(request.number));
        return Response.json({ ...mutation(), run } satisfies PullRequestReviewRunMutationResponse, { status: 201 });
      })),
    },
    '/api/v1/pull-request-reviews/runs/stop': {
      POST: withJsonBody((raw) => guarded(async () => {
        await reviews.service.stopRun(requiredId(body(raw).runId, 'runId'));
        return Response.json(mutation());
      })),
    },
    '/api/v1/pull-request-reviews/runs/post': {
      POST: withJsonBody((raw) => guarded(async () => {
        const run = await reviews.service.postRun(requiredId(body(raw).runId, 'runId'));
        return Response.json({ ...mutation(), run } satisfies PullRequestReviewRunMutationResponse);
      })),
    },
  };
}
