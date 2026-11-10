import type {GitHubApi, PrTarget, Review} from './model.js';

/** Creates the fixed-destination GitHub REST client. */
export function createApi(fetcher: typeof fetch = (...args) => fetch(...args)): GitHubApi {
  async function request<T>(path: string, token: string, payload?: object): Promise<T> {
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
    if (!response.ok) {
      throw new GitHubError(
        response.status,
        response.status === 429 ||
          response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after'),
      );
    }
    return response.json();
  }
  return {
    user: (token) => request('/user', token),
    pull: (target, token) => request(pullPath(target), token),
    reviews: async (target, token) => {
      const reviews: Review[] = [];
      for (let page = 1; page <= 1000; page++) {
        const batch = await request<Review[]>(
          `${pullPath(target)}/reviews?per_page=100&page=${page}`,
          token,
        );
        if (!Array.isArray(batch)) throw new Error('Invalid review list');
        reviews.push(...batch);
        if (batch.length < 100) return reviews;
      }
      throw new Error('Review pagination exceeded limit');
    },
    approve: (target, sha, token) =>
      request(`${pullPath(target)}/reviews`, token, {event: 'APPROVE', commit_id: sha}),
  };
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
