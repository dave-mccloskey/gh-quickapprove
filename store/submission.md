# Store submission

Upload the extension ZIP, not the store materials ZIP. Copy the listing text into the dashboard and use `screenshot.png` (1280 × 800) and `icon-128.png`. The screenshot shows the installed extension on an invented GitHub page; it contains no real repository or account information.

Before the first submission:

- Register a Chrome Web Store developer account and complete its verification requirements.
- Create the store item, choose its distribution settings, and record its publisher and extension IDs.
- Publish `privacy-policy.txt` at a publicly accessible URL. A file in this private repository or a private release cannot serve as that URL.
- Supply a working support URL and select the dashboard category and language.
- Complete and verify the privacy declarations below against the shipped code and current dashboard fields.

## Privacy declarations

Single purpose: submit GitHub pull request approvals from a compact button in the PR header.

`storage`: stores the user-supplied token, validated account identity, and approval attempt records locally. Attempt records prevent duplicate approvals when the result of a request is uncertain.

`https://github.com/*`: identifies the signed-in user and current PR and inserts the review control in the supported PR header. GitHub's client-side navigation requires the script to load on github.com pages before navigation to a PR. The extension does not collect general browsing history.

`https://api.github.com/*`: validates the token, reads the PR and its reviews, and submits an approval after a user click.

Remote code: none. All executable code is bundled in the extension.

Data handling: the extension handles authentication information (the personal access token), account identifiers, and repository/PR/review information, which can include private repository content. It stores credentials and attempt metadata locally and transmits authenticated requests only to GitHub. Declare applicable authentication, identifying, and website-content categories; do not describe the extension as handling no user data merely because the developer receives none. The publisher must verify the final declarations in the dashboard.

## Reviewer instructions

Install the extension and use GitHub's new pull request interface on github.com. Open extension settings and create a token for a GitHub account the reviewer controls, with Pull requests: Read and write permission for a test repository. Save the token. Open a PR authored by a different account in that repository. Hover the amber review icon beside Submit review, then click it once. An approval appears in GitHub and the control changes to green.

Use disposable test accounts and repositories. Do not include working credentials in this document or the release. The publisher must arrange any credentials or additional access requested by Google through the dashboard's private reviewer channel.

Check the unavailable state on your own PR, the closed and merged states, and the setup state after removing the token. The extension does not merge PRs or bypass GitHub permissions and review rules.

## Updates

Review the release notes and permission changes before uploading. Listing copy, screenshots, privacy policy URLs, privacy declarations, and distribution settings are maintained in the dashboard; the package API does not update these fields. API submission starts Google's review and publishes after approval using the existing visibility settings.

References: [listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [privacy](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [images](https://developer.chrome.com/docs/webstore/images), [publishing API](https://developer.chrome.com/docs/webstore/using-api).
