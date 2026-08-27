# Bharosa — 11-day build plan

**Buildathon:** Razorpay AI Buildathon — **Track 01, AI Growth & Agentic Commerce**
**Submission closes:** Sat 5 September 2026 · **target submit date: Fri 4 September**
**Plan rewritten:** 25 August 2026 (supersedes the MSME/B2B version)
**Base:** `ShreeniG99/Simply-cashify`, branch `claude/simply-cashify-finance-agent-mdr803`

---

## 0. Before any code

```bash
git pull                  # your laptop is at step 6; GitHub is at step 9
npm install
npm test                  # expect 217 green
npm run typecheck
git checkout -b bharosa
```

All work on `bharosa`. If it goes wrong, throw the branch away and you still have a step-9 repo to submit.

**Razorpay account:** sign up with email/phone and check whether test keys appear *before* uploading any documents. If test keys need KYC and KYC is slow, **do not wait** — Day 5 has a fixture path built in.

---

## 1. The pitch

> **Problem.** An AI agent buying from an online merchant has no way to check whether that merchant is good for it. Every agentic commerce protocol — ACP, UCP, AP2, Visa's, Mastercard's, x402 — authenticates the *agent to the merchant*. Not one does the reverse.
>
> **Solution.** Compute a merchant trust signal from reconciliation — books tie out, settlements are on time, fees are consistent, no duplicate charges — expose it over MCP, and let an agent complete a purchase through it with bounded, gated, audited money actions on Razorpay test-mode APIs.

**Track 01's brief:** *"Grow the merchant's revenue, and make them sellable to AI buyers… Build an agent that grows revenue for a merchant on Razorpay test-mode APIs, or that makes a merchant transactable by an AI buyer end to end."*

**Track 01's bar:** *"Every money action explainable, bounded and gated. Show the audit trail and one failure handled gracefully."*

Every clause of that is addressed below, deliberately.

---

## 2. Why this fits the engine with no adapter work

An online merchant on Razorpay **is** the shape your engine was built for: bank statement, settlement report, internal ledger. Your existing generator is already described in your own source as a *"Razorpay-shaped synthetic batch generator."*

So a population of merchants is **that generator, run N times, with different seeds and different injected discrepancy profiles.** No new data model, no adapter, no shape change, and `lib/engine/**` and `lib/datasets/canonical.ts` stay untouched.

**Rule for the whole build:** if a change would touch `lib/engine/` or `lib/datasets/canonical.ts`, stop and find another way.

---

## 3. What the trust signal is made of

Six components, all computed from a `ReconcileResult` you already produce. Weights hand-set and **disclosed in every response**.

| Component | Where it comes from | What it says about the merchant |
|---|---|---|
| Books consistency | auto-clear rate at the precision target, from `lib/eval/score.ts` | their records actually agree with the bank |
| Settlement integrity | rate and magnitude of `fee_math_break`, from `TieoutResult.feeMathDelta` | money arrives in the amount it should |
| Double-charge risk | rate of `duplicate_suspected` | a buyer's card won't get hit twice |
| Payout reliability | settlement lag vs the configured T+2 expectation | they're not in cash trouble |
| Refund behaviour | refund adjustments in settlement data, and their latency | they'll actually give money back |
| Unresolved rate | share of `orphan` + `low_confidence` | how much of their book they can't explain |

Each carries `evidence[]` traced back to specific records. **Nobody should have to trust the number — they should be able to recompute it.**

---

## 4. New files

```
lib/merchants/
  types.ts        MerchantProfile, TrustSignal, TrustBand, TrustConfig
  generate.ts     population generator — N merchants, each labelled
  truth.ts        the labels (never importable by trust.ts)
  trust.ts        ReconcileResult -> TrustSignal, disclosed weights

lib/eval/
  trustScore.ts   precision/recall of band vs true label

lib/tools/actions/
  razorpayOrder.ts   test-mode order create + fetch — live | fixture | unconfigured

lib/agent/
  buy.ts          verify -> gate -> transact -> audit
  gates.ts        the four gates, pure logic

mcp/tools/trust.ts   4 MCP tools
scripts/bench-trust.ts

tests/
  merchantGenerator.test.ts
  trustSignal.test.ts
  buyGates.test.ts
  trustMcp.test.ts
```

---

## 5. Day by day

One sitting each, ~3–5 hours. Every day ends with `npm test` green and a commit. **If a day slips, cut from §7 — never push into the next day.**

---

### Day 1 — Wed 27 Aug · Merchant population

`lib/merchants/{types,generate,truth}.ts`.

Wrap your existing generator to produce **20–25 merchants**, each with a true labelled personality:

| Label | Injected profile |
|---|---|
| `clean` | everything ties out, settlements on time |
| `slow_settler` | payouts consistently 2–4 days beyond T+2 |
| `fee_drift` | frequent fee-math breaks, small but persistent |
| `dispute_heavy` | elevated duplicate-suspected and refund rate |
| `degrading` | clean for three quarters, deteriorating in the last one |
| `thin` | ~12 records — **not classifiable**, and that matters (Day 6) |

Seeded and deterministic: same seed, same population.

**Done when:** `tests/merchantGenerator.test.ts` proves determinism and label distribution, and every generated merchant runs clean through the existing `reconcile()`.

**One line, today, do not skip:** add `lib/merchants/trust.ts` to `BLIND_ENTRYPOINTS` in `tests/truth-isolation.test.ts`. The scorer must never reach the labels. Cheapest credibility you will ever buy.

---

### Day 2 — Thu 28 Aug · The trust signal

`lib/merchants/trust.ts` — the six components from §3, each 0–1, combined by disclosed weights into a band: `verified` / `caution` / `avoid` / `insufficient_history`.

Three requirements:
- **Weights live in one config object and are printed in every response.** No hidden constants.
- **Every component carries evidence.** "0.72" is worthless; "0.72 — 14 of 402 settlements broke fee maths, total delta ₹1,847" is a claim.
- **Fewer than N settled records → `insufficient_history`.** Not a low score. Not a guess.

**Done when:** `tests/trustSignal.test.ts` passes and you can score the whole population.

---

### Day 3 — Fri 29 Aug · The circularity test ⭐

**This day exists because your numbers are worthless without it.**

You generate the data *and* score it. If the generator makes clean, easily-matched records, your engine matches them, the trust signal comes out high, and you have proved nothing. Your own `DATA.md` already caught this trap on Berka — the ground truth was derived from an identifier the matcher could see, so it proved speed, not difficulty.

So: **deliberately make it hard.** Strip reference numbers from a share of records, add narration noise, vary counterparty spelling, and re-run. Watch auto-clear rate and trust accuracy move.

- If accuracy **doesn't** drop, the generator is too easy — make it harder until it does.
- Then pick a realistic noise level and **report the number you got there**, not the clean one.

Write the noise level and its effect into the README. This single paragraph will separate you from every submission that reports a clean 99%.

---

### Day 4 — Sat 30 Aug · Measured accuracy ⭐

`lib/eval/trustScore.ts`, mirroring `lib/eval/score.ts`:

- Confusion matrix, predicted band vs true label
- Per-band precision and recall
- Sweep confidence, take the **lowest** threshold that clears the precision target, set `targetMissed: true` if none does
- **Cost of error, both directions**, from named assumption constants: calling a `clean` merchant `avoid` blocks a good sale; calling a `dispute_heavy` merchant `verified` puts the buyer's money at risk

Then `scripts/bench-trust.ts` and `"bench:trust"` in package.json. Print seed, commit, date. Multi-seed with mean and standard deviation.

**Done when:** `npm run bench:trust` prints numbers you'd defend under hostile questioning.

> If accuracy is mediocre, **report it and analyse why.** Your repo already reported a null result on the assignment tier, and it's one of the strongest things in it.

---

### Day 5 — Sun 31 Aug · The money action

`lib/tools/actions/razorpayOrder.ts` — create and fetch a Razorpay **test-mode** order, following your registry's existing contract: `live` when keys are set, `fixture` when replaying a recorded response, `unconfigured` when neither. Never fabricate a success.

Then `lib/agent/{gates,buy}.ts` — the purchase flow, with **four independent gates**:

| Gate | Refuses when |
|---|---|
| 1 · Trust | merchant's band is below the buyer agent's threshold |
| 2 · Amount | order exceeds the per-merchant cap the band allows |
| 3 · Dry run | `dryRun` is true — **and it defaults to true** |
| 4 · Tool | the Razorpay action isn't `live` |

`gates.ts` is pure logic — input in, decision out, no network — so every gate is unit-testable without mocks. Every attempt is logged with the **real `ToolResult.mode`**, never rewritten to success.

**Done when:** `tests/buyGates.test.ts` covers each gate independently, and you can run a purchase end to end in dry-run and in fixture mode.

**If Razorpay keys haven't arrived: build fixture mode and move on.** Do not lose a day to a KYC queue.

---

### Day 6 — Mon 1 Sep · The agent surface ⭐

Four tools on your existing `mcp/server.ts`:

| Tool | Returns |
|---|---|
| `verify_merchant` | band, six components, evidence, disclosed weights, caveat |
| `list_merchants` | paginated, filterable by band — mirror `list_exceptions` |
| `propose_purchase` | which gates pass, which fail, what *would* happen — no side effect |
| `execute_purchase` | the gated action; `dryRun` defaults true |

Requirements on all four:

1. **The caveat is in the payload**, not a footnote: hand-set weights, disclosed, not a trained model; synthetic data.
2. **`execute_purchase` cannot bypass a gate.** No override flag. If you're tempted to add one, that's the demo failing.
3. **The graceful failure.** Ask about a `thin` merchant and it returns, clearly: *"Twelve settled records. Not enough history to vouch for this merchant. Here is what I do know, and here is what I'd need."* Not a low-confidence guess.

That last one is your Track 01 *"one failure handled gracefully."* **Demo it on camera, deliberately.**

**Done when:** `tests/trustMcp.test.ts` exercises all four over real stdio including the thin merchant, and you've called them from Claude Desktop yourself.

---

### Day 7 — Tue 2 Sep · Three screens, no more

1. **Merchants** — the population, sorted by trust, band chips
2. **One merchant** — the six components, each with its evidence
3. **Agent log** — a purchase attempt and which gate stopped it

Reuse existing components. No new design system. If a screen is fighting you at hour three, **cut it** — the MCP tools are the submission.

---

### Day 8 — Wed 3 Sep · Rough video and README

**Cut the video early, not last.** It exposes gaps while you still have time.

Five minutes:

1. **0:00–0:40 — the gap.** Six agentic commerce protocols. All of them let a merchant verify the agent. None lets the agent verify the merchant. Visa's own paper admits agents get fooled by counterfeit storefronts — then ships a protocol solving the opposite direction.
2. **0:40–1:20 — where the signal comes from.** Not reviews. Reconciliation. Books that tie out, settlements on time, fees consistent, no double charges.
3. **1:20–2:30 — verify a merchant.** Show the six components and their evidence.
4. **2:30–3:30 — the numbers.** Run `npm run bench:trust` live. Precision, recall, cost of error, multi-seed — **and the noise level from Day 3.**
5. **3:30–4:20 — the agent transacts.** Call the tools from Claude Desktop. Show a purchase pass the gates. Then show the thin-merchant refusal. Then show a gate blocking a purchase.
6. **4:20–5:00 — what's real, what isn't**, and the closing line: *I built the merchant-side version because that's what I could build. You could make it authoritative, because you already have this data.*

README rewrite in parallel.

---

### Day 9 — Thu 4 Sep · Fix, final cut, **SUBMIT**

No new features. Fix what the video exposed, record the final cut, final README pass. `npm test`, `npm run typecheck`, `npm run build` clean. Push. **Submit today.**

You don't know whether the form closes at 00:00 or 23:59 on the 5th. Don't find out.

---

### Day 10–11 — Fri 5 Sep + buffer

Untouched if Day 9 went well. This exists because something will break.

---

## 6. Submission checklist

- [ ] Public repo, `bharosa` merged
- [ ] 5-minute video
- [ ] Architecture in the README
- [ ] `npm test` green; typecheck and build clean
- [ ] `npm run bench:trust` prints precision, recall, cost of error, multi-seed, **at a stated noise level**
- [ ] Four MCP tools callable over real stdio
- [ ] Thin-merchant refusal shown on camera
- [ ] A gate blocking a purchase shown on camera
- [ ] Honest-limits section written before anyone asks

---

## 7. Cut list — in this order

1. **Screens** (Day 7) — the MCP tools are the submission
2. **`execute_purchase`** — `propose_purchase` still demonstrates the gates
3. **`degrading` label** — five personalities instead of six
4. **Two of the six trust components** — four, well-evidenced, beats six half-done

**Never cut:** the circularity test (Day 3), the measured accuracy (Day 4), the truth-isolation line (Day 1). Those three are why anyone believes the rest.

---

## 8. Honest limits — write these before you're asked

1. **Synthetic merchants.** The generator is real, tested, deterministic. These are not real Razorpay merchants. Accuracy on synthetic data is not proof of production accuracy.
2. **Weights are hand-set** and disclosed in every response. Not trained, not calibrated on outcomes.
3. **The signal is self-attested.** A merchant runs this on their own books. What makes it hard to fake is that it's *derived* — faking it means faking a bank statement and a settlement report that have to agree to the paisa. **Razorpay could make it authoritative because they already see this data; I built the merchant-side version because that's what I could build.** Say this before a judge says it.
4. **Razorpay integration is test-mode only**, and if it ran in `fixture` mode, say `fixture`.
5. **No protocol integration.** This does not implement ACP, UCP or AP2. They're the motivation for the gap, not something claimed.
6. **Reconciliation health as a trust proxy is a hypothesis.** Nobody has validated that it predicts merchant misbehaviour. It's a defensible proxy, not a proven one.

---

## 9. Risks

| Risk | Guard |
|---|---|
| Razorpay KYC blocks test keys | Fixture mode, built Day 5. Never a dependency. |
| Generator too easy, numbers meaningless | That's Day 3, and it's non-negotiable. |
| Trust accuracy comes out poor | Report and analyse. A reported null result already worked in this repo. |
| Scope creep into recovery, lending, protocols | Everything not in §4 is out. Put it in the README as future work. |
| Nothing committed by Day 5 | Commit daily. A half-built branch beats an unpushed masterpiece. |

---

## 10. The line that does the most work

Open with it, close with it, put it in the README:

> **Every agentic commerce protocol on earth lets a merchant verify an AI agent. Not one lets an agent verify the merchant. This is the missing half — and the signal comes from reconciliation, not reviews.**
