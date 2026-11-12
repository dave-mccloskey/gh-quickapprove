# GitHub Quick Approve

Adds a compact amber review button beside **Submit review** in GitHub’s new PR interface. Click once to approve immediately. The button shows when you have already approved, the PR is merged or closed, or approval is unavailable.

## Build & install

Use Node.js 22.8 or newer:

```sh
npm ci
npm run package
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/extension`. Refresh any GitHub tabs that were already open. The distributable ZIP is `dist/gh-quickapprove.zip`; unzip it before loading it unpacked.

Source is strict TypeScript. Building compiles it to JavaScript and copies the required HTML, CSS, and manifest into a clean output directory. The packaged extension has no runtime dependencies or remote code.

## Connect GitHub

Click the key button in a PR header or the extension’s toolbar icon to open settings. The token creation link prefills the name **GitHub Quick Approve**, description, 180-day expiration, and **Pull requests: Read and write** permission. Select the repository owner and **All repositories**, review the settings, generate the token, then paste it into settings and save. GitHub requires repository access to be selected on its form; the link cannot prefill that choice. All repositories covers the selected owner, rather than every owner you can access. Use the same account you are signed in to on GitHub. Organization approval, a shorter expiration, or SSO authorization may also be required.

Settings show the connected account after validation. Return to the PR and click the amber review button. Saving a token never submits a review. An invalid token changes the header button to an amber key; a repository access problem preserves the token and explains the problem.

A compatible classic token also works; private repositories require the broader `repo` scope. A fine-grained token limits the grant to the selected owner and permissions.

## Approval & recovery

The extension leaves pending draft reviews untouched; finish those in GitHub. A changed commit requires reviewing the new changes and clicking again. Already approved, own, merged, and closed PRs show distinct inactive states. Hover or focus the button for the explanation.

If an approval request has an uncertain result, the extension blocks another attempt even after a browser restart. Open the review history and use **Recheck**. **Allow another attempt** acknowledges that a retry may create a duplicate; it only clears the block. A separate click is required to approve again.

The token is stored only in this Chrome profile and sent only to GitHub’s API. Local storage is not an encrypted vault. Removing the token in settings does not revoke it at GitHub. A compromised browser, extension, local profile, or GitHub page remains a security risk; the [security design](docs/superpowers/specs/2026-11-10-quick-approve-design.md#security) describes the boundaries.

## Develop & verify

```sh
npm ci
npx playwright install chromium
npm run check
```

Checks compile the extension, run lint/format checks, exercise the worker and API behavior, and load the actual extension in isolated Chromium profiles. Browser tests intercept GitHub pages and API responses with invented fixtures; they do not approve real PRs or establish compatibility with every live GitHub rollout. Generic UI screenshots appear in `test-results/`.

For fast iteration, run `npm run build` after TypeScript changes, then `npm run test:unit`. Unit tests use fake clocks or explicit async signals and run in one process. `npm run test:integration` covers subprocess and packaging checks. Browser tests load a temporary extension copy with shortened timing configuration and a fresh build fingerprint; production timing defaults and `dist/extension` stay unchanged.

After changing source, run `npm run build`, reload the extension in `chrome://extensions`, and refresh the PR tab. Run `npm run format` to apply formatting. Only github.com’s new PR interface is supported; GitHub Enterprise hosts and legacy PR views are outside this version’s scope.

## Releases

Use **Create release** in GitHub Actions to build a date-numbered release with the extension ZIP and store submission materials. **Submit to Chrome Web Store** is a separate manual workflow. See the [publishing guide](docs/publishing.md) for setup, authentication, and recovery instructions.

## Report a problem

Open extension settings and choose **Export diagnostic report** after a stuck spinner or unexpected behavior. Attach the downloaded JSON with a short description of what happened. History survives worker and browser restarts, so you can export after a problem recovers. Exporting does not call GitHub or submit an approval.

Diagnostic history stays local and is bounded to seven days and 2,000 events, plus unfinished operations. It records build/browser versions, timings, state transitions, safe error categories, and pseudonymous context IDs. It excludes tokens, account/repository names, URLs, and PR contents. Use **Clear history** to delete it or turn **Record diagnostic history** off. Neither action removes your token or clears an uncertain approval attempt.

After installing this update, reload the extension and refresh existing GitHub tabs once. Recording starts in the updated scripts; earlier incidents cannot be reconstructed retroactively.
