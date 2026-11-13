import {timing} from './timing.js';
import type {GitHubApi, GitHubUser, PrTarget, Review} from './model.js';
import {diagnosticErrorFields, emitDiagnostic} from './diagnostics.js';
import type {DiagnosticTrace} from './diagnostics.js';

/** Creates a GitHub client that requests only approval metadata. */
export function createApi(
  fetcher: typeof fetch = (...args) => fetch(...args),
  trace?: DiagnosticTrace,
): GitHubApi {
  async function request<T>(
    query: string,
    variables: object,
    token: string,
    endpoint: string,
    traceId?: string,
    page?: number,
  ): Promise<T> {
    const spanId = crypto.randomUUID();
    const start = performance.now();
    emitDiagnostic(trace, 'api.begin', {spanId, traceId, endpoint, page});
    try {
      const response = await fetcher('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({query, variables, operationName: operationNames[endpoint]}),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(timing.apiRequestMs),
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
      const result: GraphResponse<T> = await response.json();
      // A mutation can succeed partially; its errors cannot establish a definite rejection.
      if (result.errors?.length) {
        const types = result.errors.map((error) => error.type);
        const status = ['approve', 'submitReview'].includes(endpoint)
          ? undefined
          : graphErrorStatus(types);
        throw new GitHubError(status, types.includes('RATE_LIMITED'));
      }
      if (!result.data) throw new Error('Missing GitHub data');
      emitDiagnostic(trace, 'api.end', {
        spanId,
        traceId,
        endpoint,
        outcome: 'ok',
        durationMs: performance.now() - start,
      });
      return result.data;
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
    submitReview: async (reviewId, action, token, traceId) => {
      const events = {changes: 'REQUEST_CHANGES', comment: 'COMMENT', approve: 'APPROVE'};
      if (!reviewId || !Object.hasOwn(events, action)) throw new Error('Invalid review submission');
      const data = await request<SubmissionData>(
        submitReviewMutation,
        {reviewId, event: events[action]},
        token,
        'submitReview',
        traceId,
      );
      const review = data.submitPullRequestReview?.pullRequestReview;
      if (!review || typeof review.state !== 'string') throw new Error('Invalid GitHub review');
      return {id: databaseId(review.fullDatabaseId), state: review.state};
    },
    user: async (token, traceId) => {
      const data = await request<{viewer: GraphUser | null}>(userQuery, {}, token, 'user', traceId);
      if (!data.viewer?.login) throw new Error('Invalid GitHub identity');
      return {id: databaseId(data.viewer.databaseId), login: data.viewer.login};
    },
    pull: async (target, token, traceId) => {
      const data = await request<PullData>(
        pullQuery,
        targetVariables(target),
        token,
        'pull',
        traceId,
      );
      const pr = data.repository?.pullRequest;
      if (!pr) throw new GitHubError(404, false);
      if (
        !pr.id ||
        !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) ||
        typeof pr.merged !== 'boolean' ||
        !/^[a-f\d]{40,64}$/i.test(pr.headRefOid)
      )
        throw new Error('Invalid GitHub pull request');
      return {
        id: databaseId(pr.fullDatabaseId),
        nodeId: pr.id,
        state: pr.state.toLowerCase(),
        merged: pr.merged,
        user: authorIdentity(pr.author),
        head: {sha: pr.headRefOid},
      };
    },
    reviews: async (target, token, author, traceId) => {
      if (!author) throw new Error('Missing GitHub review author');
      const reviews: Review[] = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 1; page <= 1000; page++) {
        const data: ReviewsData = await request<ReviewsData>(
          reviewsQuery,
          {...targetVariables(target), author, cursor},
          token,
          'reviews',
          traceId,
          page,
        );
        const connection = data.repository?.pullRequest?.reviews;
        if (!connection) throw new GitHubError(404, false);
        if (
          !Array.isArray(connection.nodes) ||
          typeof connection.pageInfo?.hasNextPage !== 'boolean'
        )
          throw new Error('Invalid GitHub review list');
        reviews.push(...connection.nodes.map((review) => reviewMetadata(review)));
        if (!connection.pageInfo.hasNextPage) return reviews;
        const next = connection.pageInfo.endCursor;
        if (typeof next !== 'string' || !next || cursors.has(next))
          throw new Error('Invalid GitHub review cursor');
        cursors.add(next);
        cursor = next;
      }
      throw new Error('Review pagination exceeded limit');
    },
    approve: async (pullRequestId, commitOid, token, traceId) => {
      if (!pullRequestId) throw new Error('Missing GitHub pull request ID');
      const data = await request<ApprovalData>(
        approveMutation,
        {pullRequestId, commitOid},
        token,
        'approve',
        traceId,
      );
      const review = data.addPullRequestReview?.pullRequestReview;
      if (!review || typeof review.state !== 'string') throw new Error('Invalid GitHub review');
      return {id: databaseId(review.fullDatabaseId), state: review.state};
    },
  };
}

function numericHeader(response: Response, name: string) {
  const value = response.headers.get(name);
  return value !== null && /^\d+$/.test(value) ? Number(value) : undefined;
}

function graphErrorStatus(types: Array<string | undefined>) {
  if (types.includes('RATE_LIMITED')) return 429;
  if (types.includes('FORBIDDEN')) return 403;
  if (types.includes('NOT_FOUND')) return 404;
  return undefined;
}

function databaseId(value: number | string | null | undefined) {
  const id = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
    throw new Error('Invalid GitHub database ID');
  return id;
}

function targetVariables(target: PrTarget) {
  return {owner: target.owner, name: target.repo, number: target.number};
}

function authorIdentity(author: {databaseId?: number | null} | null): GitHubUser {
  // Deleted accounts and non-user actors cannot match the authenticated human viewer.
  return {id: author?.databaseId == null ? 0 : databaseId(author.databaseId), login: ''};
}

function reviewMetadata(review: GraphReview | null | undefined): Review {
  if (!review || typeof review.state !== 'string') throw new Error('Invalid GitHub review');
  return {
    id: databaseId(review.fullDatabaseId),
    ...(typeof review.id === 'string' && review.id ? {nodeId: review.id} : {}),
    state: review.state,
    user: authorIdentity(review.author),
  };
}

class GitHubError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly rateLimited: boolean,
  ) {
    super('GitHub request failed');
  }
}

interface GraphResponse<T> {
  data?: T | null;
  errors?: Array<{type?: string}>;
}

interface GraphUser {
  databaseId: number | null;
  login: string;
}

interface GraphPull {
  id: string;
  fullDatabaseId: string | null;
  state: string;
  merged: boolean;
  author: {databaseId?: number | null} | null;
  headRefOid: string;
}

interface PullData {
  repository: {pullRequest: GraphPull | null} | null;
}

interface GraphReview {
  id?: string;
  fullDatabaseId: string | null;
  state: string;
  author: {databaseId?: number | null} | null;
}

interface ReviewsData {
  repository: {
    pullRequest: {
      reviews: {
        nodes: Array<GraphReview | null>;
        pageInfo: {hasNextPage: boolean; endCursor: string | null};
      };
    } | null;
  } | null;
}

interface ApprovalData {
  addPullRequestReview: {
    pullRequestReview: {fullDatabaseId: string | null; state: string} | null;
  } | null;
}

interface SubmissionData {
  submitPullRequestReview: ApprovalData['addPullRequestReview'];
}

const operationNames: Record<string, string> = {
  user: 'QuickApproveUser',
  pull: 'QuickApprovePull',
  reviews: 'QuickApproveReviews',
  approve: 'QuickApproveApprove',
  submitReview: 'QuickApproveSubmitReview',
};

const userQuery = `query QuickApproveUser {
  viewer { databaseId login }
}`;

const pullQuery = `query QuickApprovePull($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id fullDatabaseId state merged headRefOid
      author { ... on User { databaseId } }
    }
  }
}`;

const reviewsQuery = `query QuickApproveReviews($owner: String!, $name: String!, $number: Int!, $author: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(first: 100, after: $cursor, author: $author) {
        nodes {
          id fullDatabaseId state
          author { ... on User { databaseId } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const approveMutation = `mutation QuickApproveApprove($pullRequestId: ID!, $commitOid: GitObjectID!) {
  addPullRequestReview(input: {pullRequestId: $pullRequestId, commitOID: $commitOid, event: APPROVE}) {
    pullRequestReview { fullDatabaseId state }
  }
}`;

const submitReviewMutation = `mutation QuickApproveSubmitReview($reviewId: ID!, $event: PullRequestReviewEvent!) {
  submitPullRequestReview(input: {pullRequestReviewId: $reviewId, event: $event}) {
    pullRequestReview { fullDatabaseId state }
  }
}`;
