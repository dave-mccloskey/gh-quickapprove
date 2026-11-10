import type {GitHubUser, PrTarget, PullRequest, Review, ViewState} from './model.js';

/** Parses a supported PR URL without accepting caller-controlled path segments. */
export function parsePrUrl(value: string): PrTarget | null {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== 'https://github.com' || url.username || url.password) return null;
  const match = url.pathname.match(
    /^\/([a-z\d](?:[a-z\d-]{0,38}))\/([a-z\d_.-]{1,100})\/pull\/([1-9]\d*)(?:\/(?:commits|checks|files|changes)(?:\/[^?#]*)?)?\/?$/i,
  );
  if (!match || ['.', '..'].includes(match[2])) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  const [, owner, repo] = match;
  return {owner, repo, number, key: `${owner}/${repo}/${number}`.toLowerCase()};
}

/** Derives the viewer's available action from authoritative PR and review data. */
export function reduceState({
  pr,
  user,
  reviews,
  pageUser,
  pendingAttempt,
}: {
  pr: PullRequest;
  user: GitHubUser;
  reviews: Review[];
  pageUser?: string;
  pendingAttempt?: boolean;
}): ViewState {
  const base = {sha: pr.head.sha};
  const result = (kind: string, label: string) => ({...base, kind, label});
  if (pr.merged) return result('merged', 'This PR is merged');
  if (pr.state !== 'open') return result('closed', 'This PR is closed');
  if (!pageUser || pageUser.toLowerCase() !== user.login.toLowerCase()) {
    return result(
      'account',
      `Token belongs to ${user.login}. Sign in to that GitHub account or update your token`,
    );
  }
  if (pr.user.id === user.id) return result('own', "You can't approve your own PR");
  if (pendingAttempt)
    return result('uncertain', 'Approval result unknown. Check the review history before retrying');
  const own = reviews.filter((review) => review.user?.id === user.id);
  if (own.some((review) => review.state === 'PENDING'))
    return result('pending', 'Finish your pending review in GitHub');
  const decisive = own
    .filter((review) => ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state))
    .at(-1);
  if (decisive?.state === 'APPROVED') return result('approved', 'You approved this PR');
  return result('available', 'Quick approve');
}
