# GitHub Quick Approve privacy policy

GitHub Quick Approve uses a GitHub personal access token supplied by you to read pull request and review information and submit approvals at your request. It reads the signed-in GitHub username and the current pull request identity from supported GitHub pages to select the correct account and pull request. Its GitHub GraphQL requests select your account ID and username; pull request IDs, state, merged status, head commit ID, and author ID; and your own review IDs, state, and author ID. Review queries filter by your username; approval responses contain only the submitted review's ID and state. The extension does not request or receive profile location, pull request descriptions, or review comment bodies through these API responses. It does not request device geolocation.

Your token and validated account identity are stored in local extension storage in your Chrome profile. The extension also stores approval attempt records to prevent an uncertain request from being retried accidentally. These records identify a repository, pull request, account, and commit. They are not synchronized through Chrome.

The extension sends authenticated requests directly to https://api.github.com. GitHub receives your token and the request information needed to provide its service. The extension does not send this information to its developer or an analytics provider. It does not sell user data, serve ads, or execute remotely hosted code.

Diagnostic history is recorded locally by default to investigate problems such as a stuck loading indicator. It contains timestamps, extension and Chrome versions, a build fingerprint, request categories and HTTP status codes, timings, state transitions, and pseudonymous correlation IDs for tabs and PRs. It excludes access tokens, account names, repository names, URLs, commit IDs, PR contents, raw exception messages, and raw stack traces. The private key used to generate context pseudonyms is not included in exported reports.

Diagnostic history keeps up to seven days and 2,000 recent events, plus up to 100 unfinished operations. You can turn recording off, clear history, or export a JSON report in extension settings. Reports are downloaded locally and are not uploaded automatically. The developer receives a report only if you choose to share it. Removing a token does not clear diagnostic history.

You can remove the stored token in extension settings. Removing it does not revoke it at GitHub. Approval attempt records may remain to prevent duplicate submissions; uninstalling the extension removes its local extension storage, including diagnostic history. GitHub retains submitted reviews according to its own policies.

Local extension storage is not an encrypted vault. Protect your browser profile and revoke tokens in GitHub settings when they are no longer needed.

Support and privacy inquiries: open an issue in this project's GitHub Issues tracker, linked from its Chrome Web Store listing. Do not include access tokens or private repository details in public issues.
