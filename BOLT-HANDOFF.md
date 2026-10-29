# Bolt handoff: Legacy-to-Agent MCP Bridge

## Target and readiness

**Construction-only; runtime unverified. Intended Bolt action: INSPECT AND PREPARE ONLY.** This is a local Node stdio package, not a web app. Its stand-in oracle and bridge were authored by the same builder using coding agents. No push, GitHub import, cloud provisioning, hosted execution, or publication is authorized by this handoff or has occurred.

| Item | Inventory and status |
|---|---|
| Product Git/app root | The inner `legacy-mcp-bridge/` package; import only that repository if a future owner-authorized import is arranged. The outer folder is planning/coordination. |
| Repository target | Local Git only, no remote. Intended branch/revision must be selected and recorded by the owner for any future import. |
| Database choice | **No database.** No Bolt Database or connected Supabase project is needed. |
| Migrations / baseline | Not required; no SQL schema, migration history, tables, RLS, RPCs, extensions, or synthetic database seeds. |
| Hosting | Local Node process launched by a stdio-capable MCP client. No hosted server or Bolt stdio/oracle execution promise. |
| Backend services | Functions, auth, storage buckets, Realtime, schedulers, queues, and workers: **Not required.** |
| Publication | Prepare only; no deployment or publication action. |
| Owner prerequisites | Separate authorization and GitHub/revision access for a future import; local activation first for executable claims. No Bolt account credentials are requested here. |

## Source inventory and missing artifacts

Authored source includes fixed-width decoder/copybook validation and five bridge tools under `src/`, MCP stdio under `src/server/`, a separate synthetic program under `legacy/`, parity/parser/comparator and mutation probes under `parity/`, raw baseline tools/scoring/loop under `eval/`, providers/persistent ledger under `lib/`, literal traps/layouts/copybooks, tests, report generation, and an offline demo source.

Dependencies have not been installed; the lockfile is absent. Build output, both generated fixture views, generated seeded parity cases, actual fixture/oracle/seeded hashes, frozen evaluation inputs, and live model/price pins are missing. All install/type/lint/test/build/generator/oracle/parity/mutant/stdio/demo/eval commands remain unexecuted. Syntax/JSON parsing and source review are construction checks only. `results/results.md` is a pending template, not an experiment report.

## Local commands and configuration

These are documented **future local activation** commands, not instructions for this inspect-only Bolt task to execute:

| Purpose | Command / source | Current outcome |
|---|---|---|
| Runtime | Declared Node `>=22.6`, ESM; TypeScript 5.7.3 / MCP SDK 1.25.2 / zod 3.25.76 / Vitest 3.0.5 | Compatibility unverified. |
| Initial dependencies | `npm install` in the product root; preserve the resulting lockfile; later `npm ci` | Not run; no lockfile. |
| Type/lint/tests | `npm run typecheck`, `npm run lint`, `npm test` | Not run. |
| Fixture construction | `npm run gen:fixtures`; then verify and freeze actual hashes | Not run; both views absent. |
| Build / output | `npm run build` → `dist/`; stdio entry `dist/server/stdio.js` | Not run; output absent. |
| Parity / mutations | `npm run parity -- --json`, `npm run mutants` | Not run; trap/seeded scope must remain explicit. |
| Offline verification | `npm run test:stdio`, `npm run demo`, `npm run eval:mock`, `npm run readonly-proof` | Not run; installed dependencies, generated fixtures, and applicable build/freeze prerequisites required. |
| Report generation | `node --experimental-strip-types --disable-warning=ExperimentalWarning lib/evalkit/resultsMd.ts` | Not run; reads direct `results/*.json`, defaults to `results/results.md`; optional `--out <path>`. |
| Client configuration | Local MCP client uses `node /absolute/path/to/legacy-mcp-bridge/dist/server/stdio.js` | Pending actual client validation. |
| Public/browser env | Not required; there is no browser client or database client. | None. |
| Bolt server secrets | **Not required.** | Do not enter local live-eval credentials into Bolt. |

The stdio server serves the canonical attacked fixture view and writes hashes/sizes-only audit records to local `results/audit/audit.jsonl`. Unwritable audit output returns an `internal` tool error and stderr diagnostic. Its five tools need no API key. Fixture read-only scope does not prohibit separate local audit/results writes.

`ANTHROPIC_API_KEY` is an optional **local-process** secret used only for a separately authorized future live evaluation; it is not a Bolt secret or public/frontend variable. `AGENT_MODEL` must match the activation-pinned model; `LIVE_BUDGET_USD` must fit the recorded cap. `.env.example` contains names/placeholders; there is no automatic dotenv loader. CLI `--mode mock|live` chooses the mode; the example `PROVIDER=mock` does not select a runtime adapter. Missing key or pending model/prices refuses live operation. No key or model/price value is configured in this construction.

## Freeze and evidence requirements

Freeze 1B must generate both fixture views, check deterministic bytes, populate actual `fixtures/MANIFEST.json` and `legacy/ORACLE.manifest.json` lengths/hashes, and commit/tag before parity. Seeded generation is later performed with `node --experimental-strip-types parity/genSeededCases.ts`; explicit tolerance case lists must be updated. Before seeded runtime evaluation, `parity/seeded.manifest.json` needs `status: "generated"`, `output: "parity/cases.seeded.jsonl"`, nonempty `freeze_date`, and the actual output `sha256`.

Before held-out exposure, the authorized dev pilot must settle resource feasibility and dated current model/prices. `eval/split.manifest.json` must pin both question files, D router, policy code/recipes, resources, prices, and the seeded artifacts at `../parity/cases.seeded.jsonl` and `../parity/seeded.manifest.json` relative to `eval/`. Set actual split/resource frozen statuses/dates, then commit/tag. Pending source manifests are not frozen evidence. The live-heldout path verifies pins and creates exclusive local `results/heldout-v1.started.json`; preserve it with ledger history. Repeats require a new versioned split and disclosure.

`scripts/readonly-proof.ts` hashes all file names/content in **both** fixture views before/after parity, mutants, and mock evaluation, including failed actions. The demo reuses the wrapper. Its authored checks have never run. Raw C/C2 outcomes currently have null `fixture_digest`; preserve fixture manifests plus both-view proof receipts or disclose that exact byte provenance remains unpinned in those outcomes.

Mock A recipes and deterministic D do not measure a live model; mock C/C2 are `scripted_fixture_unavailable`. Separate mock/live artifacts and run/split identifiers must remain intact. Resource ceilings and a US$5 whole-experiment budget are proposals, not measured results. Ledger reservation assumes serialized UTF-8 request bytes plus 4,096 framing tokens conservatively bound native input usage; confirm that assumption, SDK usage, retry accounting, and persistence in an authorized local pilot before relying on the cap. Do not invent accuracy, latency, cost, mutation figures, or successful runs.

## Infrastructure and external steps

Database/migrations, edge functions/CORS, auth providers/redirects, storage policies/uploads, Realtime publications, scheduled jobs, webhook registrations, and cloud/server secrets are all **Not required** for the current product. There are no cloud resources to provision or applied migrations to reconcile. No frontend or HTTP wrapper is in scope. A future hosted adaptation would need a separate design, authorization, and actual destination/runtime verification.

## Acceptance checks and receipts

| Check | Required evidence | Current status |
|---|---|---|
| Source inspection | Intended product root/revision and exact local entrypoints | Source inventory authored; future imported revision not selected. |
| Dependencies and local checks | Preserved lockfile; actual type/lint/test/build output | Pending; all commands unexecuted. |
| Fixture/oracle/seeded freezes | Generated bytes and actual manifest hashes/statuses | Pending; source placeholders only. |
| Real stdio and offline demo | Actual client connection from unrelated cwd, five tools, masked trap, independent report, three scripted journeys, cleanup and both-view proof | Pending; source/tests only. |
| Evaluation / reports | Identified runs/splits, feasible baseline policy, ledger/provenance receipts and generated report | Pending; no model or experiment figures. |
| Bolt import/runtime | Owner-selected source access; inspect concrete runtime gaps | Not attempted; no hosted stdio claim. |
| Cloud setup / publish | Not required for this inspection task | No action authorized or performed. |

See [README.md](README.md), [LIMITATIONS.md](docs/LIMITATIONS.md), and [DEFERRED-VALIDATION.md](docs/DEFERRED-VALIDATION.md) for the detailed local contract and remaining checks.

## Prompt for a future authorized Bolt inspection

> **INSPECT AND PREPARE ONLY.** Read BOLT-HANDOFF.md in the imported inner legacy-mcp-bridge product repository at the owner-selected revision. This is a construction-only local Node MCP stdio/oracle package with **no database** and no web frontend. Inspect actual source and package commands; report missing generated corpora, lockfile/build/runtime validation, frozen manifests, and any concrete Bolt import/runtime gaps. Preserve the package design and source boundaries. Prepare a reviewable plan with actual file names and pending owner/local checks. Do not assume Bolt hosts MCP stdio or child-process oracle execution. Do not add a database, web UI, HTTP transport, functions, auth, storage, Realtime, scheduler, or cloud secrets. Do not install/run the package or initiate paid/live evaluation under this inspection prompt. Do not provision or change cloud resources, apply migrations, deploy, enter credentials, push, or publish. Do not present proposed resources, placeholder manifests, scripted fixtures, or unexecuted checks as completed integrations or measurements.
