# GitHub Quick Approve security review

Review date: 11/10/26. Scope: [extension design](2026-11-10-quick-approve-design.md), including the Security section. A separate security-review agent performed the review and rechecked the revised design against its findings. This was not a code audit, penetration test, or review by an external security firm.

## Verdict

**Both findings are resolved in the design; no material design-level security issue remains open.** The reviewer considers the design suitable for implementation planning, subject to the residual risks below and subsequent source/package review and browser verification. There were no high- or critical-severity findings.

## Findings & disposition

### Medium: uncertain submissions lacked a durable recovery contract

A request can reach GitHub while its response is lost. If the worker then terminates, an in-memory lock disappears. A later review list that does not show the write does not establish that it failed; allowing another click can create a duplicate approval.

**Resolved:** before POST, persist a minimal account/PR/commit attempt record and await successful storage. An unresolved record blocks subsequent approvals across tabs and worker/browser restarts, including token replacement/removal. Resolve only on definitive rejection or confirmed success. Missing reviews, timeouts, and generic server errors leave the result uncertain. Recovery offers review history and Recheck; an explicit reset warns about possible duplication and requires a separate fresh approval click. The record contains no credential or review body.

The reviewer rechecked this contract and marked the finding resolved. The implementation must test interruption before dispatch, during POST, and after server-side success with a lost response. This mechanism does not promise exactly-once delivery.

### Low: document identity alone did not invalidate in-page navigation

Navigating from PR A to B and back to A can retain the browser document. A document ID and matching URL can therefore accept an old attempt after an intervening route change. A long-lived port's initial sender metadata is not fresh route state.

**Resolved:** bind attempts to a route generation that changes on each detected transition; cancel stale attempts. Before dispatch, obtain a fresh acknowledgment from the initiating content script confirming route generation, account, PR, and displayed SHA, and check the current browser tab URL. A missing or mismatched acknowledgment cancels dispatch. Keep the request target and commit fixed through the final non-atomic race.

The reviewer rechecked these requirements and marked the finding resolved. Test A-to-B-to-A navigation explicitly.

## Required implementation verification

- Trusted-context storage restrictions protect reads and change notifications through browser restart and extension reload. If the API is unavailable or fails, credential use and saving fail closed.
- Credential commands accept only the exact packaged options-page sender. Content scripts receive no token, storage snapshot, or secret-bearing notification.
- Worker operations reject foreign origins, child frames, malformed routes/messages, arbitrary request destinations, redirects, and caller-controlled mutation fields. Authenticated pagination stays on constructed GitHub API routes.
- Token replacement/removal during validation and preflight cannot restore removed credentials or allow queued writes with the old token. Already dispatched writes remain subject to reconciliation.
- Error rendering and logs leak no token or raw private API data. Packaged code and CSP contain no remote executable code, development/test assets, or unnecessary permissions.
- Synthetic click/keyboard events cannot dispatch writes; native keyboard activation works. Navigation, identity mismatch, changed commits, concurrent tabs, and pending reviews preserve the specified approval boundaries.

## Residual risks

**The injected button is not trusted UI against a compromised GitHub page.** A malicious page script can move or disguise it and induce a genuine click. Trusted-event checks prevent simple scripted activation, not clickjacking. Page-derived account matching cannot cryptographically establish the browser session identity. Eliminating those risks would change the approved inline one-click interaction.

A compromised local profile, browser, or extension package can expose and misuse the token within its granted permissions. Local storage is not an encrypted vault. An expiring fine-grained token limits the grant to the selected resource owner and permissions; a classic token may grant broader access. After the review, the user chose All repositories as the setup default. That grant covers all repositories under the selected owner, including future repositories; it does not retain the earlier recommendation of a repository allowlist.

A push or navigation can race the final check. The attempt fixes the PR and commit it will approve, but there is no atomic browser/API transaction. GitHub's own review and branch-protection policies remain authoritative. Explicit recovery of an uncertain write can still cause duplication; the recovery warning states that limitation.

## Primary references checked

- [Chrome service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): termination and loss of worker globals.
- [Chrome MessageSender contract](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender): sender context and document identity.
- [Chrome extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage) and [Chromium storage access-level implementation](https://github.com/chromium/chromium/blob/main/extensions/browser/api/storage/storage_utils.cc): trusted-context storage controls and persistence.
- [Chrome extension security guidance](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure) and [cross-origin request guidance](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests): message authority, request destinations, and safe rendering.

## Implementation review (11/10/26)

A fresh independent code/security reviewer inspected the TypeScript source, privileged operations, tests, manifest, and build/packaging scripts. It reported three medium-severity findings and one low-severity finding; none were critical or high severity.

- **Medium: stale reconciliation could delete a newer attempt record.** PR state reads, reconciliation, resets, and approval creation now share one per-PR operation queue. A regression reproduces the overlapping read/delete/write sequence and verifies the new uncertain record continues to block a second write.
- **Medium: a delayed 401 could restore a removed token.** Invalidation captures its credential revision before yielding and checks the expected generation inside serialized credential persistence. A regression removes the token during the old identity check and verifies it stays removed.
- **Medium: navigation within a PR could leave the button permanently busy.** Navigation invalidation clears local submission state and forces route reconciliation while the worker retains its durable write protection. A browser regression navigates with an approval response delayed and verifies the new tab state recovers.
- **Low: a failed token removal appeared successful.** Settings accept only the expected success state before changing connection controls; returned worker errors remain visible and preserve Remove. A loaded-extension browser test injects a storage failure and verifies that recovery UI.

The implementer reproduced each finding with a failing regression, applied fixes, and ran the unit/package and browser suites successfully. The reviewer did not re-review the fixes; this disposition is backed by those regressions and the implementer's verification, not a second independent sign-off.

Additional browser checks verify trusted-context token isolation, rejected content-script credential commands, native keyboard activation and synthetic-click rejection, cross-tab updates, invalid token recovery, and uncertain-write protection across a real browser restart. Package verification checks a clean compile and excludes TypeScript source, tests, plans, and dependencies from the ZIP. UI screenshots use invented repository data.

**Live authenticated GitHub remains unverified.** Browser coverage uses intercepted pages/API responses and isolated test profiles. The reviewer's declined items (live GitHub behavior, screenshot quality, final package contents, and post-fix verification) were handled by fixture-based browser tests, visual inspection, package checks, and regressions where applicable; those checks do not replace a live rollout test. The residual risks above still apply.
