# Simply Cashify — working rules

Reconciliation engine (bank ↔ settlement ↔ ledger) with measured accuracy and a typed,
honest exception list. Currently being extended with **Bharosa** — a merchant trust signal
derived from reconciliation health — for the Razorpay AI Buildathon, Track 01.

**The one question Bharosa answers:** should this agent send money to this merchant, right
now, for this amount?

**Shape:** deterministic evidence → AI judgment on the residual → a hard gate on the action.
Trust tiers 1–3 compute six Beta-posterior components from `ReconcileResult` with no LLM.
Tier 4 (`lib/merchants/adjudicate.ts`) sends only the ambiguous residual to an LLM, which
must conclude `approve` / `approve_with_cap` / `request_evidence` / `decline`. The gate in
`lib/agent/gates.ts` bounds the action regardless of what tier 4 said. **Tier 4 advises; it
never holds the purse, and it may only hold or lower a band, never raise one.**

**Read `BUILD-PLAN.md` before starting work.** It is the day-by-day plan and it is authoritative.

---

## Hard rules — do not break these without being asked

**1. Never modify `lib/engine/**` or `lib/datasets/canonical.ts`.**
They are verified, benchmarked and tested. New capability goes in new folders beside
them (`lib/merchants/`, `lib/agent/`). If a change seems to require touching them,
stop and say so instead of doing it.

**2. Money is `bigint` in minor units. Never a float.**
`0.1 + 0.2 !== 0.3` under IEEE-754, and in reconciliation that surfaces as a phantom
₹0.01 fee-math break. Use `toMinor()` / `formatMinor()` from `lib/datasets/canonical.ts`.

**3. Never fabricate a result.**
Every external tool returns `ToolResult<T> = { mode: 'live' | 'fixture' | 'unconfigured', data, reason? }`.
A tool either returns a real value, a recorded value *labelled as replayed*, or it
declines with a reason. It never invents a number and never reports success for
something that did not happen. Audit logs keep the real `mode` — they are never
rewritten to look better.

**4. The scorer must never see the answer key.**
`lib/merchants/truth.ts` holds ground-truth labels. Nothing that scores itself may import
it, enforced by `tests/truth-isolation.test.ts` — which needs its **own describe block and
own truth-module constant** per family, not an append to the shared array.

⚠️ The walker's regex matches `import type … from`, so a **type-only import from
`truth.ts` fails isolation** even though no runtime data flows. Shared types live in
`lib/merchants/types.ts`; `truth.ts` holds label data only.

**5. NEVER tune the generator to make a metric look better.** ⚠️
This is the most important rule in this file.

The generator produces the data *and* we score against it, so it is trivially possible
to make accuracy look excellent by making the data easy. That would make every number
in this project meaningless.

- If accuracy is low, **investigate why and report it**. Do not adjust the generator.
- Changing generator difficulty is a deliberate, separate act, done to make the data
  *harder* and more realistic — never to move a score.
- Any change to generator difficulty is recorded in the README with its effect on
  the metrics, in both directions.
- A reported null or negative result is a **stronger** submission than a tuned win.
  This repo has already reported one (the optimal-assignment tier does not improve
  accuracy on this data) and kept it in deliberately.

**6. Claims must be traceable.**
Every score carries an `evidence[]` array pointing at the specific records behind it.
"0.72" is worthless. "0.72 — 14 of 402 settlements broke fee maths, total delta ₹1,847"
is a claim someone can check.

**7. Do not invent external facts.**
Statistics, market figures and legal provisions go in `FACTS.md` with sources. If you
need a number that is not there, say so — do not generate a plausible one. This project's
whole thesis is honesty about what is real.

---

## Conventions

- **TypeScript, strict.** `npm run typecheck` must stay clean.
- **One file per responsibility.** Prefer five small detectors over one big one.
- **Pure logic where possible.** Decision functions take input and return a decision
  with no network calls inside, so they are testable without mocks.
- **Tests alongside every new module**, in `tests/<name>.test.ts`, using Vitest.
- **Secrets live in `.env.local`**, never `.env.example`, never committed. Test keys
  (`rzp_test_…`) are still secrets.

---

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Full suite — run after every change, not at the end |
| `npm run typecheck` | TypeScript, no build |
| `npm run build` | Production build |
| `npm run dev` | Dev server, port 3000 |
| `npm run bench` | Existing reconciliation benchmark |
| `npm run bench:trust` | Trust-signal benchmark — the numbers you cite |
| `npm run mcp` | MCP server over stdio |

---

## Definition of done for any change

1. `npm test` green
2. `npm run typecheck` clean
3. New behaviour has a test
4. Nothing in `lib/engine/` or `lib/datasets/canonical.ts` changed
5. Any new claim in the README traces to a number the code actually produces

Commit at the end of every working session. A half-built branch that is pushed beats
a perfect one that is not.

---

## Scope is frozen

The problem statement and the file list in `BUILD-PLAN.md` are final. New ideas go into
the README under future work — not into the build. Three pivots have already happened and
a panel cannot evaluate a thesis, only what runs.

## Deadline

Submission closes **Sat 5 September 2026**; **submit Thursday 3 September.** Eight days
from 27 August. When time is short, cut from `BUILD-PLAN.md` §5 — never cut the circularity
test, the measured accuracy, the truth-isolation block, tier 4, or the decision-trace screen.

**Screens are timeboxed to their slot.** Reuse the existing components and the DECLUTTR
design system; do not build a new one. If a screen is not working when its slot ends, it
ships as it is or it goes. Polish is unbounded.
