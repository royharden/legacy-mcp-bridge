# Limits of the current implementation and evidence

This is a construction-only source package. Coding agents authored the implementation and tests; the stand-in legacy oracle was built by the same builder as the bridge. Install, typecheck, lint, tests, build, fixture/seeded generation, oracle execution, parity, mutation runs, stdio connection, demo, and all evaluation remain unexecuted. Source syntax/JSON checks and reviews do not substitute for those runs. Runtime failure lists, survivor/kill counts, accuracy, cost, and latency have not been measured; later values must come from identified generated reports.

## What parity could establish

The oracle and bridge implement the same written synthetic behavior separately. They can share a wrong interpretation and still agree. Oracle independence guards prevent code reuse across the boundary; they cannot supply an independently sourced real legacy specification. The fixed-column parser and report spec can also share a misunderstanding. This is no proof of compatibility with a production legacy program.

Parity covers named projections over selected inputs. Layout meaning/quirk prose and some report request echoes are outside those projections. Timestamp ignoring and raw-versus-masked synthetic tax-id divergence are declared tolerances; a tolerance can conceal a substantive difference if its reason or scope is wrong. Tests for missing, stale, and unexplained tolerances are authored but unexecuted.

The twelve mutation probes were chosen by the author and mapped to planted traps. Detection of those faults says nothing quantitative about unknown bugs, naturally occurring defect distributions, or other systems. Full/smoke/schema-only comparisons must list actual survivors and infrastructure-invalid results from `results/mutants.json`; none has run. Trap-only scope is not a completed seeded experiment.

Malformed complete-record behavior is intentionally strict in the bridge: a reached winning defect, or an unreadable key during a scan, yields `internal`; duplicate losers with readable keys can be skipped. The oracle can print `?`/`INVALID` for some malformed fields. These error paths are not claimed to be generally equivalent, and generated corpora are intended to avoid complete-record defects. A skipped truncated tail is separately specified behavior.

## Domain and runtime boundaries

The data is synthetic, newline-free fixed-width ASCII with packed-decimal and low-value filler exceptions. There is no EBCDIC support, real customer data, mainframe connector, transport security, HTTP endpoint, or authenticated multi-user service. The copybook parser accepts a small elementary-item subset; it rejects nested/variable layouts, `REDEFINES`, `OCCURS`, `COPY`, binary clauses, and other unsupported syntax. Copybooks alone omit behavioral rules such as status X, duplicate handling, date aging, and masking.

The tool cap applies to complete masked payloads; cursor paging and capped aging provenance have different meanings. Aging totals can be complete while contributor pointers are incomplete. `source_complete`, omitted counts, warnings, and cursor markers must be preserved by consumers. Physical source pointers identify records in a particular fixture view, not immutable identities across regenerated datasets.

The stdio server masks tax ids and labels free text as untrusted; these are defense mechanisms, not evidence that a model will resist attacks. Benchmark-only raw C2/C tools expose synthetic bytes, including fields masked by the bridge. Those tools are not a real-data access policy and are not registered on the MCP server. Audit logging writes hashes/sizes outside fixtures and can fail tool calls if its destination is unwritable.

Node/SDK/TypeScript pins are declarations, not installed or exercised compatibility. There is no lockfile, emitted `dist`, generated corpus, or frozen hash baseline. Windows/WSL byte determinism, OneDrive path/junction handling, cap boundaries, cancellation, process cleanup, and stdio SDK behavior all remain activation checks in [DEFERRED-VALIDATION.md](DEFERRED-VALIDATION.md).

## Evaluation interpretation

The 30/30 split is small. Wilson intervals may be wide; overlapping intervals and a small apparent difference do not establish model superiority. Refusal/injection checks are reported as counts. All exhaustion, budget, provider, truth, and abstention failures stay in the fixed denominator; runtime infrastructure errors must remain visible rather than disappearing from a score.

A versus C2 is the intended headline comparison. A supplies typed all-match aggregates and behavioral rules, while C2 must reason over bytes with only copybooks. That structural aggregation advantage is explicit. C is a documentation-context baseline and first cut, not a fair substitute for C2. D uses regex routing/templates over the bridge, so it measures a narrow non-model baseline, not a general language agent.

Resource ceilings are proposals awaiting an authorized dev pilot and freeze 2. Raw baselines' global aging/account-search categories are conservatively marked constrained under the cumulative input-token budget. Per-question feasibility must be recorded before held-out exposure; impossible or budget-starved raw runs cannot justify a general bridge-value claim. The proposed full ceilings are not expected to fit a fair full three-model-condition experiment within the proposed US$5 cap without adjustment or an explicit cut. No cut has been applied to the 60 source slots.

Scripted development recipes exercise A; D is deterministic. C/C2 mock conditions are explicitly `scripted_fixture_unavailable` and retain their slots. Scripted outputs never become live model accuracy, latency, token, or price measurements. The demo's four slots are not a benchmark run. Live artifacts identify each run and split; reporting must not combine different runs into a misleading complete comparison.

Factual scoring checks typed values/list order and sources extracted from oracle reports; this is deterministic checking, not proof of complete reasoning or sufficient explanations. Injection checks compare each attacked result with its clean twin and reject forbidden tool attempts. Only three planted injection locations and six refusal requests are represented; passing them would not establish general prompt-injection resistance.

Per-outcome `fixture_digest` is currently present through A/D's bridge and null through C2/C's raw-tool condition. A raw outcome alone therefore does not pin the exact served byte view. Retain generated fixture hashes and the both-view read-only proof with any such run; without them, disclose the provenance gap. The authored proof hashes all names/content in both views even after failures, but it has not run.

The ledger retains reservations and unknown outcomes across processes and refuses before an over-cap attempt. Its conservative bound assumes full serialized UTF-8 request bytes plus 4,096 framing tokens bound native input usage. That assumption, reported SDK usage/pricing, durability, and retry/cancellation integration remain unverified. Unknown outcomes reserve projected cost rather than asserting a known bill; a cap mechanism is not a measured spending result. Model and dated price pins remain pending.

Generated fixture/oracle freeze 1B and seeded/split/resource/policy/price freeze 2 are future work. The seeded gate requires actual output bytes and hashes, not merely a pending manifest. The held-out receipt guards one exposure in this split version; deleting it cannot make a rerun unseen. Post-exposure changes require a new versioned split and disclosure. Development loading does not open held-out questions.

## External validity

The prior-art search was scoped and incomplete; this project makes no comprehensive novelty or best-in-class claim. Patterns were adapted into original local modules rather than proving compatibility with other projects. No Bolt import, hosted stdio runtime, cloud resource, or publication has been validated. The [handoff](../BOLT-HANDOFF.md) permits inspection/preparation only and records no required database or backend provisioning.
