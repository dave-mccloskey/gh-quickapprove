# Releases

Run **Create release** from `main` in GitHub Actions. It checks the project and creates a `YYYY.MM.DD.N` release using the Pacific date. Upload the extension ZIP; the separate `store-materials` ZIP contains this extension's completed listing fields, description, privacy disclosures, reviewer instructions, icon, and three 1280 × 800 screenshots.

The listing links to this repository's `PRIVACY.md` and GitHub Issues. Make the repository public before publishing to Chrome Web Store. The support link uses its existing Issues tracker. Repository visibility is not changed by either workflow.

Run **Submit to Chrome Web Store** separately with the release name. Choose **upload-only** to stop before review or **submit-for-review** to publish after Google approves it. Listing fields and image uploads still go through the store dashboard; this workflow submits the extension ZIP.

The `chrome-web-store` GitHub environment needs these values:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `CWS_SERVICE_ACCOUNT`
- `CWS_PUBLISHER_ID`
- `CWS_EXTENSION_ID`

Restrict the environment and Google OIDC trust to this repository's submission workflow on `main`. Use [Google's GitHub OIDC setup](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account) and [link the service account to the store publisher](https://developer.chrome.com/docs/webstore/service-accounts). Store credentials are separate from the GitHub token used inside the extension.

Rerunning a finalized release preserves its assets. A partial draft or a timed-out store request needs inspection before retrying. Start a new release run rather than replacing an existing version's ZIP. After **upload-only**, submit that upload in the dashboard. A published extension needs a newer release version for every update.

After changing the UI, run `npm run test:e2e -- --grep "ready-to-upload store"`, inspect the three `test-results/store-0*.png` images, and copy them to the corresponding filenames in `store/assets/`. The committed PNGs are the release listing images.
