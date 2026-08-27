# Bharosa — 8-day build plan

**Track 01, Razorpay AI Buildathon.** Submission closes **Sat 5 Sept 2026**; **submit Thu 3 Sept.**
**Rewritten 27 August 2026.** Supersedes all earlier versions. Scope is frozen.

---

## 0. The problem statement

> **Should this agent send money to this merchant, right now, for this amount?**

One question. Everything in the repo is evidence for it.

Framing for the video:

> An AI agent about to pay a merchant it has never transacted with has nothing to check.
> Every agentic commerce protocol authenticates the agent to the merchant; none does the
> reverse. Reviews are fakeable. Reconciliation isn't.

---

## 1. The architecture in one line

**Deterministic evidence → AI judgment on the residual → a hard gate on the action.**

| Layer | What it does | LLM? |
|---|---|---|
| Trust tiers 1–3 | Six components computed from `ReconcileResult`, each a Beta posterior | No |
| Trust tier 4 | Adjudicates the ambiguous residual: `approve` / `approve_with_cap` / `request_evidence` / `decline` | **Yes** |
| The gate | Bounds the action regardless of what tier 4 said | No |

This mirrors `lib/engine/adjudicate.ts`, which already does exactly this one layer down —
deterministic tiers 1–3, LLM on the residual, and a system prompt that says **declining is
success, not failure.** Same discipline, new domain.

**The line that carries the panel:**
> AI judgment isn't putting an LLM everywhere. It's knowing where an LLM belongs — and
> where it must never be trusted with the money.

---

## 2. Design decisions — settled, do not reopen

**`degrading` — KEPT.** Recency decay in the Beta update weights recent evidence more
heavily, so a merchant that was clean and is slipping falls out of the maths for free.
**No separate windowed component.**

**`insufficient_history` — evidence-based, not a magic number.** A merchant is
unclassifiable when its credible interval is too wide to place it in a single band —
the data literally cannot tell which band it is in. Plus a hard floor on n.
**Both parameters are pinned in config today, before any score exists.**
Make the boundary contested: a few merchants at 40–70 invoices, not just `thin` at 12
against a default of 180.

**Band derivation — the minimum conservative lower bound across components sets the band,
and the response names the binding component.** Perfect books with a 40% duplicate-charge
rate must read `avoid`, not `caution` — an average would hide that. One number, one label,
and an evidence line that writes itself: *"caution — capped by duplicate-charge rate,
which had the weakest evidence."*

**Beta-Bernoulli with recency decay — ADOPTED** into the synthetic design. A posterior with
a wide credible interval *is* the mathematical statement of "not enough evidence." This
kills the hand-set-weights criticism and makes the refusal principled, with no new data
source and no timeline risk.

**Olist — REJECTED.** Non-commercial licence is a real caveat; hand-picking merchants into
personality buckets relocates circularity rather than removing it; the review-score
component contradicts the thesis; and it does not address the AI Judgment gap, which was
the actual problem. If asked about real data, the answer is in `FACTS.md` §4.

---

## 3. New files

```
lib/merchants/
  types.ts      shared types — trust.ts imports from HERE, never from truth.ts
  truth.ts      label data only
  generate.ts   population via the existing generator + post-processing
  beta.ts       Beta posterior, recency decay, conservative lower bound
  trust.ts      six components -> band, with evidence
  adjudicate.ts tier 4 — LLM on the ambiguous residual

lib/agent/
  gates.ts      pure logic: trust / amount / dryRun / tool-mode
  buy.ts        verify -> adjudicate -> gate -> act -> audit

lib/tools/actions/razorpayOrder.ts   test-mode order, live | fixture | unconfigured
lib/eval/trustScore.ts               precision/recall vs labels
mcp/tools/trust.ts                   3 tools
scripts/bench-trust.ts

app/merchants/                       3 screens — reuse existing components, no new design system
  page.tsx                           the population, banded
  [id]/page.tsx                      one merchant's evidence, intervals visible
  trace/page.tsx                     one purchase decision, end to end
```

---

## 4. The eight days

Every day ends with `npm test` green and a commit.

### Day 1 — Thu 27 Aug (today) · Population
Wrap the existing generator per merchant with derived seeds. Inject personalities by
**post-processing the returned batch** — copy, never mutate; touch only fees, tax, date,
or appended rows; never id, reference, or matching-relevant fields. Update `raw` alongside
any perturbed field. Freeze perturbation magnitudes in a dated config object.
New `describe` block in `tests/truth-isolation.test.ts` with its own truth-module constant,
plus a stub `trust.ts` so the test has something to walk.

→ verify: same seed twice is deep-equal (hash the serialised population, not counts);
every label present; `await reconcile(batch)` resolves for all merchants;
`git diff --stat lib/engine lib/datasets/canonical.ts` is empty.

### Day 2 — Fri 28 Aug · Trust, tiers 1–3
`beta.ts` then `trust.ts`. Six components, each a Beta posterior with recency decay,
each carrying `evidence[]`. Band from the minimum lower bound; name the binding component.

→ verify: one unit test per component against a hand-built batch with a known answer;
a thin merchant returns `insufficient_history`, not a low score; the config is present in
the returned payload.

### Day 3 — Sat 29 Aug · Circularity + measured accuracy ⭐
Deliberately make the data harder — strip references, add narration noise, vary spelling —
and watch accuracy **drop**. If it doesn't, the generator is too easy; make it harder until
it does. Then `trustScore.ts` and `bench-trust.ts`: confusion matrix, per-band precision
and recall, lowest threshold clearing the target, `targetMissed`, cost of error in both
directions from named assumption constants, multi-seed mean and standard deviation.

→ verify: `npm run bench:trust` prints seed, commit, date and the numbers — **at a stated
noise level.** Write that noise level and its effect into the README, both directions.

### Day 4 — Sun 30 Aug · Tier 4 — the AI Judgment piece ⭐
`merchants/adjudicate.ts`, mirroring `lib/engine/adjudicate.ts`. Ambiguous merchants only.
The model gets the evidence and must conclude with `approve`, `approve_with_cap`,
`request_evidence`, or `decline`. The system prompt says declining is success.
No key configured → reports `skipped_no_key` honestly, exactly as tier 4 does today.

→ verify: tests against a scripted mock client covering each conclusion, malformed
arguments, and mid-call failure. The band is never *raised* by tier 4 — only held or lowered.

### Day 5 — Mon 31 Aug · The money action
`razorpayOrder.ts` in the registry's existing three modes — no change to `registry.ts`.
`gates.ts`: trust band, amount cap, `dryRun` defaulting true, tool mode. Pure logic.
Every attempt logged with the real `ToolResult.mode`, never rewritten.

→ verify: each gate unit-tested in isolation; a purchase runs end to end in dry-run and
in fixture mode.

### Day 6 — Tue 1 Sep · The agent surface + screens 1 and 2
Three tools on the existing MCP server: `verify_merchant`, `list_merchants`,
`purchase` (one tool, `dryRun` defaults true — not two). Caveat in every payload.
No override flag anywhere.

→ verify: `tests/trustMcp.test.ts` over real stdio, including the thin-merchant refusal.
Call them from Claude Desktop yourself.

Then two screens, over data that already exists, using components that already exist:

**Merchants** — the population, sorted by band. The "so what" view.

**One merchant** — the six components, each with its Beta posterior drawn as a **credible
interval, not a bar.** This is the screen that earns its place: an interval that is wide
*shows* why `insufficient_history` is about evidence rather than an arbitrary cutoff, and
the binding component is the one whose lower bound is furthest left. Highlight it.

### Day 7 — Wed 2 Sep · Screen 3 — the decision trace ⭐ + rough video

**One purchase, end to end, as a picture.** Trust computed → tier 4 adjudicated → each gate
evaluated → action or refusal, with the reason at every stop and the evidence hanging off
each node. Rejected paths greyed out and labelled.

This is the strongest screen in the project and it did not exist in earlier drafts. Track
01's bar is *"every money action explainable, bounded and gated. Show the audit trail and
one failure handled gracefully."* This screen **is** that sentence, rendered. A panel reads
it in eight seconds; the same information as JSON takes them two minutes and they won't.

Same treatment works for a single settlement from the base engine — bank credit at the
centre, the batch, the payments, the invoices, and the candidates the matcher rejected with
the reason on each edge. If you have time, it's the best thirty seconds you can film.

Then cut the rough video.

Five minutes, to a stopwatch:
1. **0:00–0:40** the gap — six protocols, all agent→merchant, none the reverse
2. **0:40–1:20** where the signal comes from — reconciliation, not reviews
3. **1:20–2:20** verify a merchant; show the components and their evidence
4. **2:20–3:10** the numbers, live, at the stated noise level
5. **3:10–4:20** the agent transacts — then the thin-merchant refusal, then tier 4 declining,
   then a gate blocking. **Four failure paths, on camera.**
6. **4:20–5:00** what's real, what isn't, and: *I built the merchant-side version because
   that's what I could build. You could make it authoritative — you already have this data.*

### Day 8 — Thu 3 Sep · Fix, final cut, **SUBMIT**
No new features. `npm test`, `npm run typecheck`, `npm run build` clean. Push. Submit.

### 4–5 Sep · Buffer
Untouched if Day 8 went well.

---

## 5. Cut list — in this order

1. **Screen 1 (merchants list)** — the least load-bearing of the three
2. `list_merchants` tool — `verify_merchant` alone carries the demo
3. Two of the six components — four well-evidenced beats six gestured at
4. Live Razorpay — fixture mode, stated honestly, costs one sentence
5. **Screen 2 (one merchant)** — only if Day 6 overruns badly

**Screen 3, the decision trace, is not on this list.** It is the audit trail made visible
and it does more rubric work than either of the others.

**The screens rule:** each screen is timeboxed to its slot. If it is not working when the
slot ends, it ships as it is or it goes. Polish is unbounded and screens are where
hackathon projects die — the MCP tools still carry the submission if every screen fails.

**Never cut:** the circularity test, the measured accuracy, the truth-isolation block,
or tier 4. Those four are the submission.

---

## 6. Honest limits — write before you are asked

1. Synthetic merchants. Generator is real, tested, deterministic; the merchants are not real.
2. Reconciliation health as a trust proxy is a **hypothesis**, not a validated predictor.
3. Component priors and the decay half-life are chosen and disclosed, not fitted.
4. Razorpay is test-mode only — and if it ran in `fixture`, say `fixture`.
5. No protocol integration. ACP, UCP and AP2 are the motivation, not a claim.
6. Tier 4 advises; it never holds the purse. The gate is what actually bounds the money.

---

## 7. The rule that matters most on Day 3

When accuracy comes back mediocre, the move that will feel obvious is making the
perturbations more extreme so they are easier to detect. **That is generator tuning and it
voids every number in the project.** Investigate, report, and analyse instead.
Perturbation magnitudes change only in the harsher direction, recorded both ways.
