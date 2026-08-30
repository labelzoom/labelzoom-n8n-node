# Conformance fixtures

Language-neutral test fixtures that every LabelZoom SDK in this repository must satisfy.

- **What the SDKs must do:** [`../docs/API_CONTRACT.md`](../docs/API_CONTRACT.md)
- **How to run these from a new language:** [`../docs/CONFORMANCE.md`](../docs/CONFORMANCE.md)

```sh
node conformance/lint.mjs      # validate the fixtures themselves (no dependencies)
```

| | |
|---|---|
| `spec.json` | version, defaults, and the authoritative case list |
| `cases/request/` | an SDK call → the HTTP request it must produce |
| `cases/response/` | a canned HTTP response → the result or error it must produce |
| `cases/retry/` | a scripted response sequence → attempt count and recorded sleeps |
| `cases/validation/` | a bad call → a local validation error, with no HTTP request sent |
| `cases/typecheck/` | a snippet that must not compile (statically typed languages only) |
| `skips/<lang>.json` | declared skips; each one requires a reason |

`spec.json` is the source of truth for which cases exist. Every runner asserts it executed all of
them minus its declared skips, and fails otherwise — see
[CONFORMANCE.md §4](../docs/CONFORMANCE.md#4-the-completeness-assertion).

Do not edit a fixture to make a failing SDK pass. Either the SDK is wrong or the contract is;
decide which in the PR description.
