# Contributing

Run `npm test` and `npm run check` using Node 22.13+ before submitting a change. Tests start loopback services and owned subprocesses. New faults need behavior-based tests that verify the ledger, not just emitted event names. Keep the distinction between transport observation and business correctness.

Never introduce real payment, email or destructive services into the default demo. Use disposable upstreams. Avoid logging credentials or raw agent output.

Optional UI tests: `npm install --no-save playwright`, `npx playwright install chromium`, `npm run test:e2e`. Set `CHROME_PATH` for a custom Chromium executable. Screenshots are written to ignored `test-results/`.

Describe the failure reproduced, recovery expected, limitations and test evidence in pull requests.
