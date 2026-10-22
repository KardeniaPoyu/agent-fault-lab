<div align="center">

# Agent Fault Lab
### Make agent failures reproducible.

Inject real faults. Inspect recovery. Catch duplicate side effects.

[![Tests](https://github.com/KardeniaPoyu/agent-fault-lab/actions/workflows/test.yml/badge.svg)](https://github.com/KardeniaPoyu/agent-fault-lab/actions/workflows/test.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-5FA04E)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[简体中文](README.md) · **English**

</div>

## Try it online

**[Open the live demo →](https://kardeniapoyu.github.io/agent-fault-lab/)** · No login, installation, or API key.

The online version is an explicitly labelled **browser protocol simulation** with all eight scenarios, strategy comparison, event playback, JSON export and browser-local history. It does not terminate real processes, break TCP connections, or call upstream tools. Simulated outcomes are not evidence of real-agent reliability. Use the local version below for actual fault injection.

GitHub Pages deploys the demo automatically from `main`. Run `npm run build:demo` to generate `dist/` and preview with a static HTTP server. `npm run test:demo` compares the model against the real local engine scenario by scenario.

![Agent Fault Lab dashboard](docs/assets/dashboard.png)

## Why this exists

A tool timeout does not prove that the operation failed. An agent can retry a successful charge, send the same receipt twice, or repeat completed work after restarting from an old checkpoint.

Agent Fault Lab turns those edge cases into controlled experiments: **inject → observe → inspect effects → export evidence → reproduce**. Compare deliberately naive and resilient agents against the same fault schedule, with independent processes and durable ledgers.

The built-in agents are deterministic order workers, not LLMs. This isolates recovery protocol behavior and requires no model API key. Your own agent can connect through HTTP tools, a fixed-upstream proxy, or a process supervisor. The web interface is currently in Chinese.

## Quick start

Requires **Node.js 22.13+**; Node 24 LTS is recommended. Python is needed only for the Python example. Some Node versions emit an experimental SQLite warning.

```sh
git clone https://github.com/KardeniaPoyu/agent-fault-lab.git
cd agent-fault-lab
npm start
```

Open **http://127.0.0.1:4318**. No dependency installation or frontend build is required. Windows users can run `start.cmd`.

Select a scenario and launch the comparison. The default workload contains three sandbox orders of 99 currency units each. Charges are integer-cent entries in a local ledger; no real payment is made.

```sh
npm run demo
node src/cli.mjs run --scenario process-crash --strategy resilient --ci
node src/cli.mjs run --scenario lost-response --output report.json
node src/cli.mjs replay --file report.json
```

Expected key results for the default lost-response comparison:

```text
naive      FAILED | charges=4 duplicateEffects=1 retries=1 restarts=0
resilient  PASSED | charges=3 duplicateEffects=0 retries=1 restarts=0
```

FAILED means the experiment found a recovery defect. Without `--ci`, discovering a defect is still a successfully executed experiment. With `--ci`, failed assertions produce exit code 1.

## Features

- Real delayed HTTP responses, closed TCP connections, and termination of owned child processes.
- Seven fault scenarios plus a no-fault control.
- Durable SQLite effects, stable idempotency keys, checkpoint recovery, bounded retries and consumer deduplication.
- Side-by-side reports, SSE event traces, playback, scrubbing, experiment history and JSON export.
- Semantic fingerprints and re-execution from saved configuration.
- Framework-independent HTTP contract and JavaScript / Python examples.
- Zero production dependencies, loopback-only service, responsive local dashboard.

## Scenarios

| ID | Injection | Typical naive outcome | Resilient strategy |
|---|---|---|---|
| `lost-response` | Delay response after commit | Duplicate charge | Retry with stable key |
| `network-partition` | Close two connections before commit | Rapid retries | Bounded backoff |
| `commit-disconnect` | Close connection after commit | Duplicate charge | Idempotent retry |
| `process-crash` | Kill owned process after commit; restart | Duplicate effects | Checkpoint + idempotency |
| `duplicate-delivery` | Repeat a message in the response envelope | Duplicate receipt | Consumer deduplication |
| `rate-limit` | HTTP 429 with Retry-After | Rapid retries | Respect backpressure |
| `corrupt-response` | Truncated JSON after commit | Duplicate charge | Idempotent retry |
| `baseline` | No fault | Pass | Pass |

Duplicate delivery uses an explicit `deliveries` array. It does not pretend that HTTP returns two independent responses to a single request.

## Bring your own agent

**Sandbox tools:** POST `/api/runs` with `{"strategy":"external","scenario":"lost-response"}`. Use the returned `toolBaseUrl` and `token` to call `/tools/charge` and `/tools/receipt` with `X-Lab-Token`. Keep `operation` stable for detection and `idempotencyKey` stable to prevent repeated commits. Finish unmanaged runs using POST `/complete`.

**Process supervision:**

```sh
node src/cli.mjs supervise --scenario process-crash -- python examples/external_agent.py
```

The supervisor injects `LAB_URL`, `LAB_TOKEN`, and `LAB_CONFIG` into its direct child. It restarts abnormal exits within a bounded budget; shell interpolation is not used.

**Existing HTTP tools:**

```sh
npm start -- --upstream http://127.0.0.1:8000
```

Create an external run and route requests through `{toolBaseUrl}/proxy/path`. Use disposable upstreams. The proxy cannot observe the upstream business ledger: reports are **inconclusive**, not proof of correctness. Duplicate delivery requires `X-Lab-Envelope: 1` and changes the response contract.

Read [ADAPTERS.md](docs/ADAPTERS.md) for payloads, checkpoints, headers, proxy semantics and SSE reconnection; read [ARCHITECTURE.md](docs/ARCHITECTURE.md) for transaction and recovery boundaries.

## Configuration and reproducibility

`--seed` selects the default fault ordinal. Override it using `--at`; `--count` sets consecutive injections; `--delay` sets the delayed response time in milliseconds. `--orders` controls workload size. `--port`, `--db`, `--output`, `--json` and `--ci` control execution and reporting. Run `node src/cli.mjs help` for examples.

Ordinals count matching tool invocations, including retries, not business order numbers. Defaults: seed 42, three orders, 450 ms client timeout, 900 ms delayed response, five attempts per operation, two process restarts. Built-in runs have a 20-second overall budget; external runs have 120 seconds.

CLI replay re-executes an experiment; dashboard playback displays recorded events. Fingerprints exclude timestamps, PIDs and run IDs while retaining configuration, semantic events and effects. External concurrency, model output and OS timing can change results. Preserve the original exported report as evidence.

## Development

```sh
npm test
npm run check

# Optional browser verification
npm install --no-save playwright
npx playwright install chromium
npm run test:e2e
```

Tests cover both strategies across all scenarios, durable idempotency, semantic replay, validation, proxy behavior, SSE resume and concurrent key reuse. Browser tests cover comparison, playback, history, adapters and mobile layout. CI is configured for Windows / Ubuntu with Node 22 / 24; consult the actual workflow badge for results.

| Directory | Purpose |
|---|---|
| `src/` | Engine, ledger, supervisor, HTTP API and CLI |
| `public/` | Build-free dashboard |
| `examples/` | Built-in JS agent and external Python adapter |
| `test/` | HTTP, process, storage and proxy integration tests |
| `scripts/` | Syntax checks and optional browser tests |
| `docs/` | Architecture, adapter contract and screenshot |

## Boundaries

This is a local testing and teaching harness, not a kernel-level injector or a universal exactly-once system. Agents must route their tool traffic through an adapter. Network faults affect experiment connections, not your network settings. Process termination targets only directly owned children, not their descendants.

The proxy buffers up to 1 MiB per request and 2 MiB per response with a 10-second upstream deadline. Streaming SSE/WebSocket forwarding and redirect following are unsupported. Upstream effects are not observable. External agent completion is self-reported and requires additional domain-specific assertions.

Ledger commits and telemetry writes are separate: a server crash can leave a committed effect without a corresponding event. The ledger is authoritative. Host/Origin validation is not multi-user authentication. Do not expose the service publicly. See [SECURITY.md](SECURITY.md).

## Contributing and license

Contribute new scenarios, agent adapters and reproducible regression cases. See [CONTRIBUTING.md](CONTRIBUTING.md) and [Issues](https://github.com/KardeniaPoyu/agent-fault-lab/issues). Licensed under [MIT](LICENSE).
