# Pending review action

The header button can submit the signed-in user's existing pending review with one click. A local setting selects the action. **Keep locked remains the default.** The user approved the radio-list mock and authorized implementation without further checkpoints.

## Behavior

- Keep locked: retain the disabled lock and finish the review in GitHub.
- Request changes: show a red diff icon; submit the pending review as `REQUEST_CHANGES`.
- Comment: show a blue speech bubble; submit the pending review as `COMMENT`.
- Approve: show a green review check; submit the pending review as `APPROVE`.

The three enabled actions publish the comments already saved in that pending review. They do not act on other people's unresolved threads. Unsaved text in GitHub's editor is outside the extension's API view. Preserve the pending review's existing body by omitting the optional body input when submitting.

Settings use four radio rows with descriptions and icon samples. Save changes immediately, report failures, and refresh existing PR tabs. Without a pending review, retain the existing quick-approve behavior. Other lock conditions remain enforced.

## Approaches

The approved radio list makes every consequence visible. A compact dropdown saves space but hides the alternatives until opened. A header action menu adds a step to the requested one-click workflow; do not add one.

## Submission boundary

Bind each activation to the displayed action, pending review ID, and head commit. Re-read metadata and settings before dispatch; a changed preference, review, account, page, or head cancels the write. Submit the existing pending review rather than creating a second review. Persist uncertain attempts across worker restarts; reconcile submission by the same review ID and expected final state. Never retry an uncertain mutation automatically.

GitHub’s pending-review submission mutation has no atomic commit-OID condition. Re-read the head immediately before submission and confirm the page again; a concurrent server-side push after that read remains possible. This differs from creating an approval, whose mutation accepts a commit OID.

## Validation

Exercise all four settings through the installed extension, including persistence, cross-tab refresh, keyboard use, mobile layout, and dark/light appearance. Cover changed context, stale actions, duplicate activation, lost replies, and recovery with service/API tests. Run lint, unit, integration, packaging, and the full browser suite.
