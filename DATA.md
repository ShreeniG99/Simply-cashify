# Dataset provenance

## Live connectors (step 3)

`api.frankfurter.app`, `date.nager.at`, `ifsc.razorpay.com` are all keyless and
architecturally supported in `live` mode — but this build environment's egress
proxy returns a 403 policy denial for all three, confirmed twice (planning
session and build session, both dated). `live` mode is real code, not a stub:
`preferLive: true` genuinely attempts the fetch and is exercised in
`tests/tools.test.ts` via a mocked `fetch`, so the logic is proven correct even
though it cannot be proven reachable from here. On an unrestricted machine the
same code path should report `mode: 'live'` — that has not been verified by
this session and is worth confirming once deployed.

## Berka / PKDD'99 (real data — scale and correctness proof)

- **Source**: Czech bank, released for the PKDD'99 Discovery Challenge.
  Original host: <https://sorry.vse.cz/~berka/challenge/PAST> (egress-blocked
  from this build environment). Fetched instead from the widely-mirrored copy
  at <https://github.com/jlacko/berka-dataset>, which reproduces the files
  byte-for-byte against the documented schema and row counts.
- **What it is**: real, anonymized transactional data from 1993–1998 —
  4,500 accounts, 6,471 standing payment orders, 1,056,320 transactions.
  We use `order.asc` and `trans.asc` only.
- **Licence**: released for academic/research use as part of the PKDD'99
  Discovery Challenge; no further restriction is stated on the mirror. Treated
  here as a research benchmark, consistent with two decades of published work
  using it the same way. If this project is ever demoed or shipped beyond the
  hackathon, re-verify the terms before continuing to bundle or redistribute it.
- **Not committed to the repo.** `data/raw/` is gitignored (67MB). Fetch with
  `npm run fetch:berka`, then `npm run bench:berka`.
- **Role in this project**: throughput and correctness **at real scale**, not
  matching difficulty. See the note in `lib/datasets/berka/truth.ts` — the
  ground truth here is derived from the same identifier the matcher is allowed
  to use (destination bank + account), so a high accuracy score demonstrates
  the pipeline runs correctly and fast on real, unmodified, million-row
  financial data — not that reconciliation was hard. Matching *difficulty* is
  the generator's job (see below), where truth is independent of every signal
  the matcher can see.
- **Measured** (commit `7e95bed`, this machine): 1,062,791 records end-to-end
  (parse + match) in 9.7s → **109,521 records/sec**. 208,282 executions
  correctly tied to their standing order, 0 wrong auto-approvals, and 382 of
  6,471 orders found to have never been executed even once in six years of
  real data — an organic orphan class nobody injected. Reproduce with
  `npm run fetch:berka && npm run bench:berka`.

## Razorpay-shaped generator (synthetic — difficulty and honesty proof)

Seeded, deterministic, no external dependency. Injects 11 discrepancy classes
including true orphans, so the honest ceiling sits below 100% by construction.
Ground truth (`lib/datasets/truth.ts`) is independent of every field the
matcher sees — the only place in this project where truth isn't itself derived
from a matchable signal. This is where the ablation table and per-class
accuracy breakdown live.

## BenchRec (real, labeled — planned, not yet integrated)

ICAIF'23 Benchmark Competition dataset, hosted on Kaggle. Kaggle is
egress-blocked from this build environment; needs a manual download and a
column-mapping adapter (`lib/datasets/canonical.ts` is designed for exactly
this — one adapter file, no engine changes). Not yet done. If added, its
licence must be checked and recorded here before any public use.
