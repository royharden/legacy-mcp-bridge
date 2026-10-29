# Results — pending activation

Construction-only template, written manually. The results renderer, demo, parity suites, mutation experiment and answer evaluation have never run. No measured metrics, generated corpora or freeze hashes are claimed.

| Evidence | Claim | Status |
|---|---|---|
| Parity | Named bridge-to-printed-report projections under declared tolerances | pending — not run |
| Mutation | Full / smoke / schema-only detection of author-chosen isolated bugs | pending — not run |
| A | Typed bridge answer correctness; compare with C2 on feasible questions | not run (live) |
| C2 | Raw bytes with copybooks; constrained questions cannot establish superiority | not run (live) |
| C | Raw bytes without copybooks; documentation context only | not run (live) |
| D | Regex/template router; model-value baseline | not run (live) |

Accuracy, Wilson intervals, tokens, known and unknown cost, latency, named failures and split-specific safety counts remain pending. Scripted fixture replay is not a model result and supplies no live metric values.

After authorized activation produces report JSON, render only the direct files under `results/`:

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning lib/evalkit/resultsMd.ts
```

Each live run and split is reported separately. Missing, malformed, partial, constrained and unattempted scope is identified explicitly; unrelated runs are never assembled into a complete comparison.
