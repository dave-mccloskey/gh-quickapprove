# GitHub Quick Approve

Status: proposed for approval. Created: 11/10/26.

## Objective

Add one compact approval button to every GitHub PR page. Clicking it submits an approval immediately using GitHub's REST API and a personal access token. The button stays in the PR header and communicates whether approval is available without requiring a hover.

The user approved the visual mockups and selected the token-backed API approach. The behavior and implementation defaults below are proposed builder decisions unless explicitly identified as approved.

## Scope & constraints

Support github.com in Chrome (Manifest V3), **only in the new PR interface shown below**, across Overview, Commits, Checks, Files changed, and commit detail pages within that interface. Legacy PR views are out of scope; do not add selectors or compatibility code for them. Direct loads, browser back/forward, and navigation without a full page reload must produce exactly one button for the current PR. Non-PR pages have no button.

Approval requires one click, with no confirmation and no review message. The extension does not merge, request changes, dismiss reviews, or edit GitHub's existing review controls. V1 ships as an unpacked extension with installation instructions; Web Store publishing, GitHub Enterprise hosts, OAuth, and multiple saved tokens are out of scope.

## Approaches

**Selected: REST API with a user-provided token.** This follows Refined GitHub's quick-approve mechanism and gives every PR tab the same submission path. The API contract is documented; installation requires token setup. The user selected this after reviewing the alternative.

Alternative: submit GitHub's existing review form using the browser session. This avoids token setup, but couples submission to GitHub's markup and review dialog lifecycle, particularly on pages without a review form. We retain DOM integration for placement only.

## User experience

**The approved visual is a 32 px square button placed immediately after Submit review**, with an 8 px gap. On tabs without that control, place it in the corresponding PR header action group. Keep it visible with the header while scrolling where GitHub provides a sticky header. Match GitHub's typography, borders, radii, and light/dark theme variables. Do not introduce a floating widget or move existing actions.

### Reference & approved PNG mockups

The user's current new PR interface is the implementation target. Its top PR action bar contains Merge status and Submit review, above the Overview/Commits/Checks/Files changed tabs. Insert the button immediately after Submit review and before the separator and existing icon actions.

![Implementation target: the user's new GitHub PR interface.](assets/quick-approve/new-pr-view-reference.png)

Approved button placement (the screenshot illustrates the action bar while viewing a diff):

![Quick approve immediately after Submit review.](assets/quick-approve/header-placement.png)

Approved resting states (no hover required):

![Available, already approved, merged, own PR, and closed button states.](assets/quick-approve/resting-states.png)

Hover behavior reference:

![Quick approve tooltip and success behavior.](assets/quick-approve/hover-and-success.png)

The resting-state board above supersedes the earlier hover board's dimmed success checkmark; use the circled check and green tinted background for Approved. Surrounding native actions are illustrative; render only actions GitHub itself provides for that PR.

### Button states

Approved resting states:

- Available: green checkmark on a neutral background; tooltip "Quick approve".
- Already approved: green circled checkmark on a subtle green background; tooltip "You approved this PR"; disabled.
- Merged: purple merge icon; tooltip "This PR is merged"; disabled.
- Own PR: muted gray lock; tooltip "You can't approve your own PR"; disabled.
- Closed without merging: muted red closed-PR icon; tooltip "This PR is closed"; disabled.

Additional builder defaults: loading and submission use a spinner and disable the button. Missing or invalid credentials use a neutral setup/key icon; clicking opens extension settings. Other unavailable states use a muted lock with the specific reason. A pending draft review uses the locked state and tooltip "Finish your pending review in GitHub". Errors use a visible error icon plus an accessible short message near the button; the message persists until dismissed or a new attempt starts. Successful approval changes the button immediately without navigating or scrolling.

All states have accessible names and tooltip descriptions available on keyboard focus. Disabled states must remain focusable with aria-disabled so their explanation is discoverable. Icon shape, color, and accessible text distinguish states. Respect reduced motion and narrow viewports.

The approved screenshots establish button appearance and placement. They do not require showing GitHub's Submit review action when GitHub itself omits it (e.g., a merged PR).

### Token setup & recovery

**Missing token:** show a neutral key icon in the same button position, with tooltip and accessible label "Set up Quick Approve". It remains clickable. Clicking opens the extension's options page in a new tab, keeping the PR open. Do not automatically open settings on install or on every PR navigation.

The options page explains that the token is used to approve as the user and is saved only in this Chrome profile. Provide a GitHub token creation link and instructions to select the intended repositories and Pull requests read/write permission. Use a masked token field and a "Save token" button.

Saving validates the candidate token against GitHub's authenticated-user endpoint before persisting it. While checking, disable Save and show "Checking token…". On success, clear the field and show "Connected as <username>" and "Return to your PR". Keep the setup tab open so the result is visible. Open PR tabs refresh through an extension notification; when the user returns, the button reflects the current PR state. **Saving or replacing a token never submits an approval**; the user clicks the green check after returning.

If validation fails, keep the candidate masked and editable, explain the error inline, and leave Save available for a corrected attempt. Do not overwrite a working saved token with an invalid candidate. A network failure says "Couldn't reach GitHub. Try again" rather than claiming the token is invalid. Displaying a connected account verifies identity, not write permission for every repository.

**Invalid saved token:** if GitHub rejects its authentication, invalidate cached eligibility and show an amber key icon with tooltip "GitHub token expired or invalid. Update token". Clicking opens options with the same message and a replacement field. Stop retrying the rejected token during navigation/focus until the user supplies a replacement. Keep Remove available. A token invalidated during a click never causes automatic resubmission after recovery.

**Valid token, unavailable repository or permission:** preserve the token and show the muted lock with an actionable message. Offer settings and Retry in the error message. Insufficient access, SSO/organization restrictions, rate limits, and temporary failures must not all be labeled invalid token. Use GitHub's error details when available; otherwise say access could not be confirmed. Missing write permission may only become apparent at submission; report it without claiming approval succeeded.

These setup and recovery states are proposed behavior; the approved PNGs cover approval/PR states. Their key icons and the options page will follow the same native visual styling.

## Components

Use plain JavaScript modules and CSS, with no runtime framework or build step. This is a builder choice for a small extension with one injected control.

1. A content script recognizes the current PR, reads the signed-in GitHub username, mounts the button, and handles GitHub navigation and DOM replacement. An observer reconciles the control without repeating API requests for unrelated DOM mutations. Stale responses cannot update another PR's button.
2. An extension service worker owns the credential and GitHub API calls. Messages expose fixed operations (load PR state and approve), never arbitrary URLs, methods, or request bodies. Validate the sender is a github.com PR tab, derive or verify its owner/repository/PR number, and call only api.github.com.
3. An extension options page saves, validates, replaces, and removes a token. Include a masked input, Save and Remove controls, validation status, authenticated username, and a link to GitHub token creation instructions. Do not display the saved token again.

Use Chrome extension local storage, restricted to trusted extension contexts. The token persists across browser restarts but is not synchronized or written into the page, messages to content scripts, logs, URLs, screenshots, or repository. Local extension storage is not an encrypted vault; a compromised local profile can expose the token. Only the options page and worker handle it. Request storage permission and host access for github.com content injection and api.github.com requests; no cookie or browsing-history permission.

Recommend a fine-grained personal access token limited to intended repositories with Pull requests read/write permission. Accept a compatible classic token for users who need it; document private-repository scope and organization/SSO restrictions. The token's authenticated user must match the signed-in page user. A mismatch disables approval and explains which account needs changing; never approve silently as another account.

## State & submission

Read the authenticated API user, PR metadata, and all pages of PR reviews. Compare numeric user IDs for author and reviewer identity. State precedence is merged, closed, account mismatch/setup, own PR, pending review, already approved, available. While loading or unable to determine state, disable approval rather than infer availability.

For already approved, use the user's latest decisive review (APPROVED, CHANGES_REQUESTED, or DISMISSED). Only APPROVED disables the button. COMMENTED reviews do not erase a decisive review; DISMISSED clears an older approval rather than resurrecting it. This state means the user's approval exists; it does not claim all branch protection or merge requirements are satisfied. On new commits, requery GitHub; do not infer dismissal solely from a changed head SHA.

Refresh on initial mount, PR navigation, return to a visible/focused tab, credential change, and immediately before submission. Avoid background polling. Bound simultaneous duplicate requests within the worker and disable the UI while a submission is in flight. Clear cached state when credentials change. Per-PR locks cover overlapping tabs within the running worker; after worker restart, authoritative review reads provide reconciliation.

**A click creates a new approval only after the latest state is confirmed eligible.** Pin it to the PR head SHA shown in the loaded state. If preflight finds a different head SHA, update the state and ask for a fresh click with "New commits arrived. Review the changes before approving." If navigation changes the PR while preflight runs, cancel the action. This does not add a confirmation dialog to the normal path.

Send a create-review request with event APPROVE, the checked commit ID, and no body/comments. Never submit or modify a pending draft review. If one exists, direct the user to GitHub's review UI. On confirmed API success, render Approved and refresh authoritative state. If a response is lost or times out, requery reviews before allowing another attempt; do not automatically retry a write. A commit arriving after preflight can still leave approval attached to the checked SHA; GitHub's review policies remain authoritative.

Handle expired tokens, inaccessible repositories, insufficient permission, organization restrictions, rate limits, and validation failures with short actionable messages. Do not claim permission is known before GitHub establishes it. An API denial leaves approval unavailable for that attempt and offers Retry after the underlying issue is fixed. Never translate an ambiguous response into success.

## Verification & delivery

Exercise the loaded extension end to end in a Chromium browser using deterministic GitHub page fixtures and intercepted API responses. Cover all approved states, setup and account mismatch, pending reviews, pagination, dismissed reviews, repeat clicks, changed commits, navigation during requests, multiple tabs, errors, and uncertain submission outcomes. Verify direct loads and in-page navigation across PR tabs, light/dark themes, keyboard focus, narrow layouts, and replacement of GitHub's header. Inspect screenshots against the approved mocks.

Use focused unit tests for review-state reduction, route parsing, and worker request validation where browser tests do not isolate those boundaries well. Run lint, tests, and extension validation before delivery. Include a manual installation and token setup walkthrough. A live test on the user's real GitHub account requires a designated test PR; do not approve an arbitrary real PR as a test. Clearly distinguish fixture verification from live GitHub verification.

## References

- [GitHub review API](https://docs.github.com/en/rest/pulls/reviews): review creation, review listing, and token permissions.
- [Chrome extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage): local storage and trusted-context access controls.
- [Refined GitHub quick-review](https://github.com/refined-github/refined-github/blob/main/source/features/quick-review.tsx): token-backed approval precedent.
- [GitHub REST authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api): invalid credentials, permission failures, and organization authentication restrictions.

## Left to the builder

Choose file boundaries, exact GitHub selectors and fallback anchors, test tooling, API caching details, and icon SVG paths. Preserve the behavior and credential boundary above. If GitHub's actual markup prevents the approved header placement on a supported tab, bring back a screenshot and a concrete alternative before changing the placement.
