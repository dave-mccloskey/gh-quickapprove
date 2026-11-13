# Pending Review Action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Configure the one-click action for the user's pending GitHub review, retaining lock as the default.

**Architecture:** Extend the existing reducer and serialized service with an action and pending-review identity. Submit that review through GitHub GraphQL. Keep the current approval lifecycle and uncertain-write journal for every review action.

**Tech Stack:** TypeScript, Chrome extension APIs, GitHub GraphQL, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-pending-review-action-design.md`

## Global Constraints

- Keep locked remains the default.
- Never retry an uncertain mutation automatically.
- Preserve the pending review's existing body by omitting the optional body input when submitting.
- Other lock conditions remain enforced.

## Review Focus

- A preference changes after rendering: cancel the stale click rather than submit a different action.
- A pending review is replaced: do not submit the replacement from the stale button.
- Submission succeeds but its response is lost: reconcile the existing review ID, not only new review IDs.
- A preference write fails or its reply is lost: restore controls and report an unconfirmed save.
- An existing approval precedes pending comments: show the configured pending action before approval status.

### Task 1: Pending-review submission and journal

**Files:** `extension/model.ts`, `extension/shared.ts`, `extension/api.ts`, `extension/service.ts`, `tests/shared.test.js`, `tests/api.test.js`, `tests/service.test.js`.

**Interfaces:** `PendingReviewAction = 'lock' | 'changes' | 'comment' | 'approve'`; view/message fields `action`, `reviewId`; API `submitReview(reviewId, action, token, traceId?)`. Settings operations `getPreferences` and `setPreferences` are restricted to the packaged options page.

- [x] Add failing tests for pending-action derivation, settings authorization, GraphQL submission, stale clicks, lost results, and recovery of the same review ID.
- [x] Run the focused Node tests and confirm missing-feature failures.
- [x] Implement metadata selection, reducer, preferences, serialized submission, and journal reconciliation.
- [x] Run `npm test`; expect zero failures.

### Task 2: Settings and header UI

**Files:** `extension/options.html`, `extension/options.css`, `extension/options.ts`, `extension/controller.ts`, `extension/content.ts`, `extension/content.css`, `extension/background.ts`, `extension/diagnostics.ts`, `tests/controller.test.js`, `tests/e2e/extension.spec.js`, `README.md`.

**Interfaces:** Consume Task 1 fields and operations. Controller snapshots the displayed action/review ID for the mutation. Settings save locally and refresh PR tabs through the service notifier.

- [x] Add failing browser tests for each setting, persistence, default lock, stale action, keyboard activation, and unknown submission outcomes.
- [x] Run the new browser tests; confirm missing UI failures.
- [x] Implement the approved radio rows and matching icons, controller action snapshots, status copy, and live refresh.
- [x] Run `npm run check`; expect zero failures. Inspect dark desktop and light mobile settings screenshots.
- [x] Review the complete diff, address correctness findings, and leave the completed feature on its feature branch.

## Execution record

Proceed inline without further checkpoints, as requested. Work in the existing checkout on `feat/pending-review-action`; the sandbox denied the initial branch ref write, then allowed the scoped escalation. No additional worktree is needed for this single active implementation.


Task 1: complete. Focused tests first failed for missing preference operations, reducer actions, and pending-review mutation; all pass after implementation. The existing unit/integration/package suites pass.

Task 2: complete. Browser tests first failed for the absent radio choices. New installed-extension tests cover each action, saved body/comments, profile persistence, live PR-tab updates, default lock, keyboard activation, lost replies, and responsive layout.

Ruling: preserve the pending review body by omitting the optional GraphQL body input; do not synthesize a summary or read unsaved editor text.

Ruling: retain the existing controller phase and operation names internally; carry action and review identity as immutable activation fields. This keeps existing concurrency tests applicable without an unrelated lifecycle rewrite.

Review: independent review found an awaited preference read after the final page acknowledgment. An installed-extension regression reproduced navigation causing a stale submission. Move preference reads before acknowledgment and use synchronous revision/in-flight-write guards afterward. The regression passes with zero submissions.

Review: native radio selection lost focus while saving because the fieldset was disabled. An installed-extension keyboard test reproduced it. Restore the selected radio's focus after saving when focus has remained on the document body; the keyboard test passes.

Ruling: keep the completed feature on its local feature branch. No remote write or deployment is needed for the authorized implementation.

Final verification: `npm run check` passed with lint/format checks, 73 unit tests, 9 integration/package tests, and 56 installed-extension browser tests. Visually inspected the dark desktop and light mobile settings and request-changes header screenshots; rows, icons, wrapping, and tooltip placement fit the approved design. GitHub responses use controlled fixtures; no live review was submitted.


## UX and native-review synchronization follow-up

UX reviewed settings branding, all actionable review controls, all completed states, and native GitHub pending-review feedback together. Implemented the compact recommendation documented in the spec, with the before/after comparison saved at `docs/superpowers/specs/assets/review-icon-system.html`.

Reproduced the stale native pending count through the installed extension: the API accepted the review while the page retained “Submit review 1.” The extension now reloads the current PR after confirmed pending-review submission. Browser tests verify the pending count clears, scroll remains at the same position, unknown results do not refresh automatically, and a late success from another PR cannot refresh the current document.

An independent code review found no additional production issues. Final `npm run check` passed: lint/format, 73 unit tests, 9 integration/package tests, and 61 browser tests. Inspected the actual dark settings header, approved status, and light mobile settings, alongside the UX mock. `npm run package` rebuilt the distributable.
