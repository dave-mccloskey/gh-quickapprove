# Agent instructions

- In the Codex macOS environment, run `npm run test:e2e` outside the sandbox
  (request `require_escalated` in the command runner). Sandboxed Chromium aborts
  during `launchPersistentContext` with `SIGABRT`, before tests can run.
- `npm run check` includes browser E2E tests, so it also needs to run outside the
  sandbox. Lint, build, unit tests, and integration tests can run inside it.
