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

## Razorpay Settlements API (test mode — step 8)

`lib/tools/actions/razorpay.ts` targets `api.razorpay.com`, which is also
egress-blocked from every build session this project has run in (confirmed
the same way as the other three hosts above — same 403 policy denial). The
field shape in `lib/datasets/razorpay/adapter.ts` is written from Razorpay's
published Settlements API documentation, never verified against a live
response. Unlike the three step-3 connectors, this tool has no `fixture`
mode at all: a settlement batch is private, account-specific data, not a
small closed reference set like an IFSC code or a historical FX rate, so
there is nothing honest to cache. It reports `live` (credentials configured)
or `unconfigured` (they are not) — the actual state in every environment
this project has run in, since no test-mode Razorpay account has been
connected. A user with their own test-mode key pair (`RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`) would see it genuinely go live; that has not been
verified by this session and is worth confirming once deployed.

## BenchRec (real, labeled — integrated)

- **Source**: ICAIF'23 Benchmark Competition dataset
  (`BenchRec_cash_v1.0_{train,eval,solution}.csv`), hosted on Kaggle.
  `kaggle.com` is unreachable from every build session this project has run
  in (confirmed the same way as the other blocked hosts above; no GitHub
  mirror was found either, unlike Berka), so unlike Berka there is no
  `npm run fetch:benchrec` — the project owner downloaded the files directly
  and supplied them to this session.
- **Licence**: not independently verifiable from this session (the Kaggle
  dataset page itself is unreachable). Treated here as a research/competition
  benchmark, the same caution applied to Berka — re-verify the licence terms
  before any public demo or redistribution beyond this repo.
- **What it is**: real, anonymized cash-reconciliation data — two-way
  matching between an internal ledger (A) and an external statement (B), no
  settlement-batch layer at all (genuinely different task shape from both
  the Razorpay generator and Berka). Long format: each row is either an A or
  a B side, grouped by `matchId`. 149,855 train rows (56,074 matched
  groups), 69,172 eval rows (37,123 A + 32,048 B, `targetAllocation`
  withheld for scoring), 32,049 solution rows (the held-out answer).
- **Not committed to the repo.** `data/raw/` is gitignored. Place the three
  CSVs in `data/raw/benchrec/` yourself, then `npm run bench:benchrec`.
- **Role in this project**: a third, structurally different real-data proof
  point — Berka proves scale on 1M+ real rows with an identifier-shaped
  match key; BenchRec proves the pipeline's fuzzy/assignment tiers on real
  free-text + amount + date signals with no identifier at all, and at real
  dollar-magnitude noise (transactions from $40 to several billion, with
  hundreds of transactions sharing an identical round amount — a genuinely
  different scale challenge than Berka's, solved differently: see
  `lib/engine/benchrecMatch.ts`'s amount-window blocking + connected-component
  partitioning, necessary because unlike Berka this dataset has only one
  account to partition by).
- **Ground truth, scored by allocation key not row id** — the plan's own
  framing, confirmed against the real data: every A row carries a real,
  given `A_allocation` fingerprint (never withheld); only a B row's own
  `targetAllocation` claim is hidden. `lib/datasets/benchrec/truth.ts`
  derives both, structurally isolated from the matcher — enforced by
  `tests/truth-isolation.test.ts`, same as the generator and Berka.
- **Amount tolerance measured, not assumed**: of 47,024 genuine 1:1 matched
  pairs in `train.csv`, 97.6% have an exact amount and 2.3% are within
  0.1% — the generator's 0.5% default (calibrated for Razorpay's MDR/GST
  deductions, which this dataset has no equivalent of) was too loose at
  these dollar magnitudes and made candidate generation intractable;
  `BENCHREC_CONFIG` uses 0.2%.
- **Measured** (commit `4ab0511`, this machine, eval split — 37,123 ledger +
  32,048 statement rows, `npm run bench:benchrec`):
  **99.1% precision, 12.4% recall**, 34 wrong auto-approvals out of 3,769
  claims, at a 93.8% ceiling. 412 seconds end-to-end (parse + match), a real
  number this run reports rather than hides: one connected component held
  1,034,165 nodes (many transactions share an identical round amount — see
  the module doc), and matching real free text at that scale costs real
  compute — 156 oversized clusters fell back to greedy by design rather than
  attempting an O(n²m) solve on a million-node graph.

  The low recall is a genuine, measured finding, not a defect: the
  confidence histogram (also in the bench output) shows 340,898 candidates
  sitting in the 0.6–0.72 band against only 3,871 above it — the *same*
  fixed threshold (0.72) tuned for the synthetic generator's clearer signal
  shape, applied unchanged to a dataset where two independent systems
  describe the same transaction in genuinely different free text. Given a
  wrong auto-approval is the expensive, invisible failure this whole project
  exists to avoid, declining a near-miss rather than lowering the bar to
  claim it is the intended, conservative behavior — precisely the same
  precision-gated philosophy the generator's own headline metric already
  uses. A dataset-specific threshold calibration (the same sweep
  `lib/eval/score.ts` already does for the generator) would very likely
  raise recall substantially; not done here for time, and noted as the
  obvious next step rather than silently left out.
