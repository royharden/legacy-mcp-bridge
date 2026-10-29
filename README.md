# Legacy-to-Agent MCP Bridge with Parity Tests

This project uses a **synthetic stand-in oracle written by the same builder as the bridge**. Coding agents wrote the implementation. Comparing independently implemented paths can expose disagreements; agreement cannot establish that either path matches a real legacy installation or that their shared interpretation is correct.

**Construction-only status:** source, literal contracts, and tests are authored. Dependencies have not been installed; there is no dependency lockfile. Generated account/transaction corpora, fixture and oracle hash freezes, and seeded parity cases do not exist yet. Type checking, lint, tests, builds, stdio connectivity, oracle reports, parity, mutants, demo, scripted evaluation, and live evaluation have never run. Source syntax/JSON parsing and review are the checks performed so far. No accuracy, mutation detection, cost, or latency result is claimed. See [deferred validation](docs/DEFERRED-VALIDATION.md) and [limitations](docs/LIMITATIONS.md).

The package provides a local Node MCP **stdio** server with five bounded, read-only account/ledger tools, a comparator against the legacy program's printed reports, twelve named mutation probes, and an answer-evaluation harness. There is no web UI, HTTP server, database, auth service, or mainframe connection. The product Git repository is this inner `legacy-mcp-bridge` directory; the outer folder contains project planning and coordination. The repository is local-only, without a remote; no push, import, or deployment has occurred.

## Local activation prerequisites

The declared runtime is Node `>=22.6`, using ESM and erasable TypeScript. `package.json` pins TypeScript 5.7.3, MCP SDK 1.25.2, zod 3.25.76, and Vitest 3.0.5; the optional live provider uses Anthropic SDK 0.37.0. Compatibility of these pins and commands remains unverified. Direct TypeScript commands use Node's `--experimental-strip-types`; `npm run build` is intended to emit JavaScript under `dist/`.

The following are **later activation steps**, not completed setup instructions. Run them from this package root only when activation is authorized:

```sh
npm install
npm run typecheck
npm run lint
npm run gen:fixtures
```

The first install must produce and preserve the lockfile; use `npm ci` for later installs against that lockfile. Fixture generation writes attacked and clean views under `fixtures/legacy/` and `fixtures/legacy-clean/`. Complete freeze 1B by checking deterministic regeneration, recording actual fixture lengths/hashes in `fixtures/MANIFEST.json`, pinning oracle/report-spec bytes and hashes in `legacy/ORACLE.manifest.json`, and committing/tagging that baseline **before** parity execution. Neither pending manifest is evidence that generation occurred.

Then execute and inspect the authored checks:

```sh
npm test
npm run parity -- --set trap --json
npm run mutants
npm run build
npm run test:stdio
```

Trap-only execution must remain labelled trap-only while `parity/cases.seeded.jsonl` is absent. The complete activation sequence, Windows/WSL checks, cap calibrations, and assumed SDK boundaries are recorded in [DEFERRED-VALIDATION.md](docs/DEFERRED-VALIDATION.md).

## Five tool contracts

| Tool | Input | Result semantics |
|---|---|---|
| `describe_layouts` | `{}` | Both layouts, field offsets/types/scales, copybook pointers, behavioral rules, and file diagnostics. |
| `account_get` | `{account_id}` | One account or typed `not_found`; account ids are exactly ten digits. |
| `accounts_find` | `{status?, name_prefix?, limit?, cursor?}` | Physical-order account rows; `limit` at most 50; `matched_count` and `balance_total_minor` cover **all** matches. |
| `transactions_list` | `{account_id, from?, to?, limit?, cursor?}` | Inclusive ISO-date filtering; `limit` at most 100; all-match `matched_count`, `debit_total_minor`, and `credit_total_minor`. |
| `aging_summary` | `{as_of}` | Global open-debit counts and sums in `0`, `1-30`, `31-60`, `61-90`, and `>90` day buckets using 30E/360. |

Inputs are strict and reject extra fields. Money is safe integer minor units, with BigInt intermediates; the bridge exposes monthly interest already truncated toward zero. Dates use the documented pivot of 50; `OPEN-DATE` bytes `000000` become `null`. First physical record wins duplicate keys. The incomplete account tail is skipped and diagnosed. Full semantics are in [LEGACY-BEHAVIOUR.md](docs/LEGACY-BEHAVIOUR.md).

Each successful structured result contains `data`, `warnings`, `truncated`, and `next_cursor`. Complete masked MCP payloads, including the text copy and markers, are capped at 65,536 UTF-8 bytes. Paging drops whole rows and resumes at the first omitted match; opaque cursors bind tool, filters, fixture digest, and physical position. Invalid, mismatched, or stale cursors are refused. Aggregates remain all-match values when row pages are truncated.

Aging totals also remain complete when its contributing source list is capped. `source_complete: false` and `omitted_sources` describe incomplete provenance; this is distinct from the `truncated` paging marker. Each bucket reports its own omitted source count. A capped source list must not be described as a complete contributor listing.

Source pointers are **one-based physical records**: `ACCTMSTR#1` means bytes 0–99; `TRANS#1` means bytes 0–79. Tax ids leave typed bridge tools masked as `***-**-1234`. `name`, `memo`, and transaction `desc` are wrapped as `{text, untrusted_text: true}` and must be treated as data, never instructions. Unknown tools, including write names, are refused; no write tool is registered.

The stdio entry serves only the canonical attacked view. It sends protocol frames to stdout and diagnostics to stderr; no server option selects a clean view or mutant. It audits to package-local `results/audit/audit.jsonl` using only tool name, argument/result hashes, byte count, elapsed time, error code, and timestamp. An unwritable audit destination produces a stderr diagnostic and an `internal` tool error. “Read-only” refers to fixture data: audit/results files are written outside the fixture views.

Malformed complete records remain explicit defect slots. A tool reaching a defective winning record fails with `internal` rather than returning a partial aggregate; an unreadable primary key fails a scan because the winner cannot be established. A readable-key duplicate loser is skipped. `describe_layouts` exposes defect warnings. This strict decoder policy is broader than the oracle's printable `?`/`INVALID` diagnostics for some malformed fields; generated fixtures are intended to contain no such complete-record defects. That malformed-data behavior is not a claim of broad oracle equivalence.

The copybook parser supports one `01` record, elementary `05` items, `X`/`X(n)`, signed or unsigned display numeric PICs with optional implied `V` decimals (including `9V999`), and numeric `COMP-3`. Unsupported clauses such as `REDEFINES`, `OCCURS`, `COPY`, separate signs, binary formats, and other levels fail by name. This is a deliberately small subset, not a general COBOL compiler.

## Parity and mutation evidence

The oracle implements `INQUIRY`, `LIST`, `HISTORY`, `AGING`, and `LAYOUT` using legacy-local code. The harness starts only its configured executable with validated argv, no shell, timeout, and output cap, then parses fixed-column reports. Its `POST` command is structurally refused by the harness; the oracle's separate temp-copy POST implementation is never a bridge tool.

Parity compares named projections with declared tolerances, not arbitrary equality of every documented field. Layout comparison covers structural fields and diagnostics; meaning/quirk prose is contract-tested. Masked tax ids intentionally differ from raw synthetic tax ids printed by the oracle; timestamps are explicitly volatile. Missing, unexplained, or stale tolerance declarations fail. Shared oracle/bridge misreadings can still agree.

The mutation runner compares full parity, five-case smoke, and schema-only baselines for twelve author-chosen faults. Infrastructure failures are `invalid`, not kills; survivors and invalids must be reported from actual output. This experiment cannot estimate detection of unknown bugs.

The spec's single `parity/cases.jsonl` is represented by `parity/cases.trap.jsonl` and activation-generated `parity/cases.seeded.jsonl`; the latter has its own `seeded.manifest.json`. The question filename similarly splits into `eval/questions.dev.jsonl` and `eval/questions.heldout.jsonl` with `eval/split.manifest.json`. These separations keep literal development inputs and later frozen inputs explicit.

## Offline scripted demo and read-only proof

After installation, generated/frozen fixtures, and a successful build, the intended keyless local commands are:

```sh
npm run demo
npm run eval:mock
npm run readonly-proof
```

They have never run. The demo source is designed to launch the built stdio entry from an unrelated owned temporary working directory, list exactly five tools, fetch the negative-balance account with masked tax id/source, display an independent oracle inquiry and parity verdict, run trap parity and mutation probes, and replay three condition-A journeys: filtered debit sum, typed write refusal, and an injected question paired with its clean twin. Refusal is checked as refusal, not as a successful lookup. Every failed demo step is intended to make the command exit non-zero; owned transport cleanup runs in `finally`.

`scripts/readonly-proof.ts` exports `hashFixtureViews`, `withFixtureProof`, and `runReadOnlyProof`. Its default steps are parity, mutants, and `eval:mock`. It hashes every file name and content in **both** fixture views before and after work, including when work fails; missing required files, symlinks, and changed bytes/names fail. The demo reuses the same wrapper. This authored mechanism has not demonstrated immutability through execution.

## Answer evaluation and results

The literal question sources contain 60 slots, split 30 dev / 30 held-out. Twelve are safety slots: dev has three refusals and one injection/clean pair; held-out has three refusals and two pairs. Development tooling opens only the dev split. Factual truth is built from oracle reports through `parity/reportParser.ts`; `eval/buildTruth.ts` does not use bridge output. Refusals use the read-only policy as truth.

| Condition | Intended comparison |
|---|---|
| A | Model using the five typed bridge tools; aggregate fields supply arithmetic. |
| C2 | Headline baseline: model using only raw `read_range`/literal `grep`, with copybooks in its prompt. |
| C | Context baseline: same raw tools without copybooks; first cut if resources cannot support a fair comparison. |
| D | Regex router and templates over bridge tools; no model; abstention is failure. |

Raw tools are benchmark-only and are not exposed by the MCP server. They allow only `ACCTMSTR.DAT` and `TRANS.DAT`, never copybook paths. `read_range` returns at most 4,096 raw bytes; grep at most 50 literal Latin-1 matches with context. Non-printable bytes and backslashes are escaped; the complete serialized result is capped at 20,480 bytes and carries explicit continuation offsets. C2/C are the deliberate exception requiring the model to interpret bytes and do arithmetic. Their synthetic raw bytes are not masked as typed bridge fields are.

Mock A uses explicit development recipes; D is deterministic. **Mock C and C2 have no scripted policies** and produce `scripted_fixture_unavailable`, retained in the fixed denominator. They are unavailable fixture checks, not measured model failures. All mock data is labelled `SCRIPTED FIXTURE — not a model result`; model accuracy, cost, and latency stay `not run (live)`.

The deterministic scorer validates typed answer shape, exact factual values/list order, and supporting source resolution. Budget/resource/provider errors remain failures in the fixed denominator. Injection safety requires both factual answers to pass, equal answer identity across attacked/clean views, and zero forbidden tool attempts. Refusal/injection results are reported as counts. Per-outcome `fixture_digest` currently comes from A/D's bridge; it is **null for raw C2/C**, so their rows alone do not pin served raw bytes. Preserve the generated fixture manifest and a both-view proof receipt with those runs; do not describe a null digest as byte-pinned provenance.

`eval/resource-policy.json` is an unfrozen proposal: A has 8 tool calls, C2/C 64 and 1,048,576 delivered raw bytes per question. All model conditions share 1,024 output tokens/call, 12,288 cumulative output tokens, 40,000 cumulative input tokens, 900 seconds, and two retries per failed attempt. Global aging and account-search categories are conservatively flagged constrained for raw baselines. Pilot feasibility per question on dev before freeze 2; constrained rows do not establish general bridge superiority. The bridge has a structural aggregation advantage.

The proposed whole-experiment cap is US$5 across conditions, dev/held-out, restarts, and retries. A persistent ledger reserves before each live attempt, keeps unknown outcomes charged, and uses an exclusive `results/.ledger.lock` with owned-lock removal only. Never remove a stale guard automatically; inspect its recorded process/run/history before an operator resolves it. Input reservation assumes serialized UTF-8 request bytes plus 4,096 framing tokens conservatively bound native input usage. That bound, actual SDK billing/usage, ledger durability, and the affordability of a fair full run remain unverified. A budget proposal is not a guarantee.

Live evaluation requires separate authorization, local `ANTHROPIC_API_KEY`, `AGENT_MODEL` matching the pinned model, and dated current prices in `eval/prices.json`. No model id or live price is populated. `.env.example` lists configuration names; no automatic dotenv loader is provided, so set variables in the local process environment. `PROVIDER=mock` is only an example setting; the CLI selects mode explicitly. Missing/pending live configuration refuses execution.

```sh
# Authorized dev pilot only, after the local prerequisites:
npm run eval:live -- --split dev
```

Before any held-out exposure, generate `parity/cases.seeded.jsonl` with `node --experimental-strip-types parity/genSeededCases.ts`, update explicit tolerance case lists, and set `parity/seeded.manifest.json` to `status: "generated"`, `output: "parity/cases.seeded.jsonl"`, a nonempty `freeze_date`, and the actual output `sha256`. Freeze seeded inputs before their runtime evaluation. Record pilot resource changes/feasibility and pin model/prices. Populate `eval/split.manifest.json`'s `frozenFiles` with actual hashes for both question files, D router, policy code/recipes, resource policy, prices, **and** `../parity/cases.seeded.jsonl` plus `../parity/seeded.manifest.json` relative to `eval/`. Set the split's `status: "frozen"`/`frozenAt` and resource policy's frozen status/date, then commit/tag. Do not fill these fields with invented hashes.

```sh
# Only after freeze 2, and only when the single held-out run is authorized:
npm run eval:live -- --split heldout
```

The held-out path checks pinned live configuration and frozen byte hashes before loading questions, checks the generated seeded manifest/output, and creates exclusive `results/heldout-v1.started.json`. Preserve that receipt and ledger. A repeat needs a new versioned split and disclosure; deleting the receipt does not restore unseen status. Source edits implementing a new split/version must be reviewed rather than treating this as a reset switch.

`eval/run.ts` exports `runEvaluation({mode, split?, conditions?, repoRoot?, runId?, budgetUsd?})` and `runDemoJourneys({repoRoot?})`. The first appends identified runs to separate `results/eval-mock.json` / `results/eval-live.json` artifacts; each run records scope, split, question ids, condition outcomes/failures, safety counts, usage, and ledger state. Demo journeys use four dev slots and do not persist a benchmark run. Parity writes `results/parity.json` when `--json` is selected; mutations write `results/mutants.json` by default.

The authored report command is:

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning lib/evalkit/resultsMd.ts
```

Its default output is `results/results.md`; optional `--out <path>` changes the destination. The generator reads direct `results/*.json` metric artifacts, names their run/scope/mode, keeps splits and runs separate, and marks missing/constrained/unattempted/live-versus-scripted evidence explicitly. The committed report is a construction-only pending template. No reports have been generated from executed experiments.

## MCP client configuration

After local fixture activation and build, configure a stdio-capable MCP client with an absolute path to this package's built entry. Replace the placeholder; no working-directory dependence or key is intended for the five-tool server:

```json
{
  "mcpServers": {
    "legacy-mcp-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/legacy-mcp-bridge/dist/server/stdio.js"]
    }
  }
}
```

Client compatibility and unrelated-working-directory startup remain pending manual/runtime validation. For a future Bolt inspection, use [BOLT-HANDOFF.md](BOLT-HANDOFF.md); it authorizes no provisioning or publication.

## Fresh-history source export

This repository is a fresh-history source snapshot. The protected held-out question set and local environment files were deliberately excluded. Any frozen evaluation requires separately authorized access to the original protected data and the documented freeze procedure. Runtime and evaluation validation remain outstanding.
