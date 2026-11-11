import type {GitHubApi, PrTarget, Review} from './model.js';
import {diagnosticErrorFields, emitDiagnostic} from './diagnostics.js';
import type {DiagnosticTrace} from './diagnostics.js';

/** Creates the fixed-destination GitHub REST client. */
export function createApi(
  fetcher: typeof fetch = (...args) => fetch(...args),
  trace?: DiagnosticTrace,
): GitHubApi {
  async function request<T>(
    path: string,
    token: string,
    endpoint: string,
    traceId?: string,
    payload?: object,
    page?: number,
  ): Promise<T> {
    const spanId = crypto.randomUUID();
    const start = performance.now();
    emitDiagnostic(trace, 'api.begin', {spanId, traceId, endpoint, page});
    try {
      const response = await fetcher(`https://api.github.com${path}`, {
        method: payload ? 'POST' : 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(payload ? {'Content-Type': 'application/json'} : {}),
        },
        ...(payload ? {body: JSON.stringify(payload)} : {}),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      emitDiagnostic(trace, 'api.headers', {
        spanId,
        traceId,
        endpoint,
        status: response.status,
        durationMs: performance.now() - start,
        rateRemaining: numericHeader(response, 'x-ratelimit-remaining'),
        retryAfterSeconds: numericHeader(response, 'retry-after'),
      });
      if (!response.ok) {
        throw new GitHubError(
          response.status,
          response.status === 429 ||
            response.headers.get('x-ratelimit-remaining') === '0' ||
            response.headers.has('retry-after'),
        );
      }
      const result = await response.json();
      emitDiagnostic(trace, 'api.end', {
        spanId,
        traceId,
        endpoint,
        outcome: 'ok',
        durationMs: performance.now() - start,
        count: Array.isArray(result) ? result.length : undefined,
      });
      return result;
    } catch (error) {
      emitDiagnostic(trace, 'api.end', {
        spanId,
        traceId,
        endpoint,
        outcome: 'error',
        durationMs: performance.now() - start,
        ...diagnosticErrorFields(error),
      });
      throw error;
    }
  }
  return {
    user: (token, traceId) => request('/user', token, 'user', traceId),
    pull: (target, token, traceId) => request(pullPath(target), token, 'pull', traceId),
    reviews: async (target, token, traceId) => {
      const reviews: Review[] = [];
      for (let page = 1; page <= 1000; page++) {
        const batch = await request<Review[]>(
          `${pullPath(target)}/reviews?per_page=100&page=${page}`,
          token,
          'reviews',
          traceId,
          undefined,
          page,
        );
        if (!Array.isArray(batch)) throw new Error('Invalid review list');
        reviews.push(...batch);
        if (batch.length < 100) return reviews;
      }
      throw new Error('Review pagination exceeded limit');
    },
    approve: (target, sha, token, traceId) =>
      request(`${pullPath(target)}/reviews`, token, 'approve', traceId, {
        event: 'APPROVE',
        commit_id: sha,
      }),
  };
}

function numericHeader(response: Response, name: string) {
  const value = response.headers.get(name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

function pullPath(target: PrTarget) {
  return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.number}`;
}

class GitHubError extends Error {
  constructor(
    readonly status: number,
    readonly rateLimited: boolean,
  ) {
    super('GitHub request failed');
  }
}
