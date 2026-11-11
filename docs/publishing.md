# Releases and Chrome Web Store

In GitHub Actions, run **Create release** from `main`. It checks the project, creates a tag and release named `YYYY.MM.DD.N`, and attaches the extension ZIP, store materials, checksums, release notes, and source commit information. The date uses Pacific time; `N` starts at 1 each day. Chrome's numeric manifest version removes date padding, while `version_name` retains the release name. Release versions are stamped into build output; source versions stay unchanged.

The extension ZIP is the file to upload. The separate store materials ZIP contains a generic screenshot, store icon, listing text, privacy policy text, permission explanations, and reviewer instructions. Review these materials before each submission. Listing and privacy fields are entered in the developer dashboard; the submission workflow uploads the extension package only.

Release creation and submission are separate manual workflows. Creating a GitHub release does not contact Chrome Web Store. Because this repository is private, its releases and their attachments remain accessible only to people with repository access.

## First-time store setup

Register and verify a Chrome Web Store developer account. Create an item in the [developer dashboard](https://chrome.google.com/webstore/devconsole) using a release ZIP, complete its listing and privacy fields using the store materials, and choose its visibility and distribution settings. Host the privacy policy at a public URL and supply a working support URL. Complete any first-publication steps Google requires. Record the publisher ID and extension ID. If visibility changes later, Google requires a manual publication with the new setting before API publication can resume.

Enable the Chrome Web Store API in a Google Cloud project and create a dedicated service account. Link its email under Account in the Chrome Web Store developer dashboard. This identity can manage the publisher's items, so use a publisher account with an appropriate scope. These credentials are separate from the GitHub token an extension user supplies.

## Configure GitHub OIDC

Create a Google Cloud Workload Identity Pool and an OIDC provider for `https://token.actions.githubusercontent.com`. Follow [Google's deployment pipeline instructions](https://cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines#github-actions).

Map the following claims:

```text
google.subject = assertion.sub
attribute.repository_id = assertion.repository_id
attribute.repository_owner_id = assertion.repository_owner_id
```

Set the provider attribute condition to all of the following, replacing angle-bracketed values with this repository's numeric IDs and actual workflow reference:

```text
assertion.repository_id == '<REPOSITORY_ID>' &&
assertion.repository_owner_id == '<OWNER_ID>' &&
assertion.ref == 'refs/heads/main' &&
assertion.workflow_ref == '<OWNER>/<REPOSITORY>/.github/workflows/submit.yml@refs/heads/main' &&
assertion.sub == 'repo:<OWNER>/<REPOSITORY>:environment:chrome-web-store'
```

Grant `roles/iam.workloadIdentityUser` on the linked service account to this pool's repository principal set:

```text
principalSet://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/<POOL_ID>/attribute.repository_id/<REPOSITORY_ID>
```

The numeric repository and owner restrictions prevent a renamed or recreated repository from inheriting trust. The workflow, branch, and environment conditions restrict which jobs can impersonate the service account. Do not create or store a service account JSON key.

In GitHub, create an environment named `chrome-web-store` and restrict its deployment branches to `main`. Add these environment variables:

| Variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full `projects/…/locations/global/workloadIdentityPools/…/providers/…` resource name |
| `CWS_SERVICE_ACCOUNT` | Email of the service account linked to the store publisher |
| `CWS_PUBLISHER_ID` | Publisher ID from the store dashboard |
| `CWS_EXTENSION_ID` | Existing store item's extension ID |

The workflow obtains a short-lived token with the `chromewebstore` scope. It does not require a publishing secret in GitHub. Configure any environment approval controls your GitHub plan supports if desired; manual workflow dispatch is the default submission control.

## Submit a release

Run **Submit to Chrome Web Store** from `main`, enter an existing finalized release name, and choose a mode:

- **upload-only** uploads the exact released ZIP and stops after processing. It leaves review submission to the dashboard.
- **submit-for-review** uploads the ZIP and submits it for Google's review. After approval, Google publishes using the existing visibility and distribution settings.

The workflow requires the release tag to belong to `main`, verifies its checksum and both manifest versions, and authenticates only after those checks pass. It blocks on publishing warnings and leaves Google's review enabled. Read the Actions summary for the returned upload/submission state; a successful run does not mean the item is approved or live.

## Recover from failures

Release creation reserves a tag for its workflow run. A rerun reuses that tag and commit. If the release is already finalized, it leaves all assets unchanged. If creation stopped with a partial draft, inspect the draft and start a new manual release run rather than replacing assets under the same version. Reserved tags can leave gaps in the daily sequence. Avoid manually creating or moving date-numbered release tags.

Submission does not retry writes. A failed or timed-out upload or publish request may already have succeeded at Google. Inspect the dashboard before retrying. Resolve pending reviews, staged submissions, or policy warnings there first. A published version requires a newer release. After **upload-only**, use the dashboard to submit the uploaded package; rerunning a workflow can attempt another upload of the same version and may be rejected by Google.

Updating a published extension requires increasing its numeric version. To undo a release, publish the corrected code as a newer release; do not move tags or replace a published ZIP.

## Local checks

Run `npm run check` before releasing. Browser tests create `test-results/store-screenshot.png` with the installed extension and invented GitHub data. To exercise release packaging locally, set `RELEASE_NAME` to a valid date-numbered version while running `npm run package`, then run `node scripts/release-bundle.js` with the same environment variable. Output appears in `dist/release/`. This does not create tags, GitHub releases, or store submissions.

The PNG icons are generated from the existing review icon in `store/icon.svg`. After editing that SVG, run `node scripts/store-icons.js` with Playwright Chromium installed, inspect the PNGs, and commit them.

References: [Chrome versions](https://developer.chrome.com/docs/extensions/reference/manifest/version), [store API](https://developer.chrome.com/docs/webstore/using-api), [store service accounts](https://developer.chrome.com/docs/webstore/service-accounts), [Google's GitHub authentication action](https://github.com/google-github-actions/auth).
