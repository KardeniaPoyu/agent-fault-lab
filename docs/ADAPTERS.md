# Adapter contract

## Sandbox tools

1. `POST /api/runs` with `{"strategy":"external","scenario":"lost-response"}`.
2. Save returned `toolBaseUrl` and `token`. Agent calls require `X-Lab-Token`.
3. `POST {toolBaseUrl}/tools/charge` or `/tools/receipt`.
4. Unmanaged agents finish with `POST {toolBaseUrl}/complete`, body `{}`. Supervised processes exit with code 0 instead.

```json
{"operation":"order-1:charge","idempotencyKey":"order-1:charge","amount":9900}
```

`operation` identifies one logical business action (1–128 chars). Keep it stable on retries; changing it defeats duplicate detection. `idempotencyKey` is optional (1–256 chars), scoped to one run. Reusing a key with different operation, tool, or amount returns HTTP 409. Amount is nonnegative integer cents; receipts require zero.

```json
{"deliveries":[{"messageId":"effect-1:result","value":{"effectId":"effect-1","operation":"order-1:charge","tool":"charge","amount":9900,"status":"committed"}}]}
```

Deduplicate messages by `messageId`. Transport or parsing failure can occur after commit; retry with the same key.

`GET /checkpoint` returns `{"completed":[]}`. POST accepts unique valid order numbers. This checkpoint schema is specific to the demo; arbitrary agents may keep their own durable state. Checkpoints cannot atomically commit with remote effects.

`POST /agent-events` accepts type `agent.retry`, `agent.completed`, `agent.failed`, `agent.message_deduplicated`, `agent.checkpoint_restored`, plus optional `operation`, `tool`, `attempt`, `code`. Telemetry is not authoritative ledger evidence.

External reports check duplicate operations and self-reported completion, not the full demo order workflow. An external agent doing no work is not evidence of task correctness. Add domain assertions against exported effects in CI.

## Supervisor

`node src/cli.mjs supervise --scenario process-crash -- python examples/external_agent.py`

The direct child receives `LAB_URL`, `LAB_TOKEN`, `LAB_CONFIG`. Two restarts, 120-second overall budget. No shell command interpolation. Child stdout/stderr is drained but not recorded because it may contain secrets. HTTP-only clients cannot request process-crash. Grandchildren are not supervised.

## Proxy

Start `npm start -- --upstream http://127.0.0.1:8000`. Create an external run; call `{toolBaseUrl}/proxy/path`. The configured upstream authority stays fixed. Forwarded headers: Content-Type, Authorization, Idempotency-Key, Accept. The lab token is not forwarded. Response status, Content-Type and Retry-After are preserved.

For duplicate delivery, send `X-Lab-Envelope: 1`. The response is an envelope with `deliveries[].value = {status, body}`, not a transparent HTTP response. Only transport is observable, so proxy reports are inconclusive. Use disposable upstreams.

## Reports

`GET /api/runs/{id}` returns metrics, assertions, effects, events, fingerprint and reproduction config. `/export` downloads the report. `/events` streams SSE with `Last-Event-ID` or `?after=N` reconnection. POST `/replay` reruns a built-in agent; POST `/cancel` ends the run. Tokens are omitted from exports/history. This is a trusted local API, not a public authentication boundary.
