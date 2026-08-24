# Simply Cashify

AI Finance Controller — multi-source cash reconciliation with measured accuracy
and an honest exception list.

Reconciles a bank statement against a Razorpay settlement report and an internal
ledger: one UTR credit covering many payments, net of MDR and GST-on-MDR, plus
refund adjustments. Every claim is scored against ground truth the matching
engine cannot see.

---

## Running it

**Requirements:** Node.js **18.18 or newer** (20+ recommended) and npm.
Check with `node -v`. If it is older, install the LTS from
[nodejs.org](https://nodejs.org).

### 1. Get the code

Cloning is better than copying files — you get the git history and can pull
later updates:

```bash
git clone https://github.com/ShreeniG99/Simply-cashify.git
cd Simply-cashify
git checkout claude/simply-cashify-finance-agent-mdr803
```

### 2. Open in VS Code

```bash
code .
```

Or **File → Open Folder…** and pick the project folder.

### 3. Install dependencies

Open the integrated terminal — ``Ctrl + ` `` — and run:

```bash
npm install
```

`node_modules/` is not in git, so this step is required even if you copied the
files across. It takes a minute or so.

### 4. Start the app

```bash
npm run dev
```

Open <http://localhost:3000> and click **Run reconciliation**.

---

## Environment variables

Copy `.env.example` to `.env.local` to enable tier 4 (LLM adjudication):

```bash
cp .env.example .env.local
# then fill in GROQ_API_KEY from https://console.groq.com/keys (free tier)
```

Without a key, the app runs fully — tier 4 is skipped and reported honestly as
`agentTier: "skipped_no_key"` rather than faked.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload, on port 3000 |
| `npm run build` | Production build |
| `npm start` | Serve the production build (run `build` first) |
| `npm test` | Run the test suite (99 tests) |
| `npm run typecheck` | TypeScript check with no build |
| `npm run bench` | Benchmark to the console — the numbers you cite |
| `npm run fetch:berka` | Downloads the real Berka dataset (~67MB) |
| `npm run bench:berka` | Throughput/correctness at scale on 1.06M real rows |

`npm run bench` accepts environment overrides:

```bash
SEED=7 INVOICES=400 npm run bench
```

Benchmarks live in the CLI rather than on the dashboard on purpose: they are
figures you quote, not buttons you press mid-demo.

---

## Recommended VS Code extensions

None are required, but these help:

- **ESLint** (`dbaeumer.vscode-eslint`)
- **Tailwind CSS IntelliSense** (`bradlc.vscode-tailwindcss`) — autocompletes
  the design tokens
- **Vitest** (`vitest.explorer`) — run tests from the sidebar

VS Code uses the workspace TypeScript version automatically. If imports look
unresolved, run **Ctrl+Shift+P → TypeScript: Restart TS Server**.

---

## Troubleshooting

**`'next' is not recognized` / `command not found`** — `npm install` has not
finished, or it was run in the wrong folder. Make sure the terminal is in the
directory containing `package.json`.

**Port 3000 already in use** — `npm run dev -- -p 3001`.

**PowerShell blocks `npm.ps1`** — Windows script execution policy. Either use
Command Prompt or Git Bash instead of PowerShell, or run once as administrator:
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**A path containing spaces** (e.g. `C:\Dev\Simply cash-ify`) works, but if you
hit odd tooling errors, a path without spaces is one less variable.

**Fonts look wrong** — DM Mono and Instrument Serif load from Google Fonts, so
the first load needs a network connection. Everything else runs offline.

---

## What it does

### The problem

A settlement is a **batch**. One UTR credit lands in the bank covering N
payments, net of fees:

```
Gross                    1,50,000
− MDR @ 2%                 -3,000
− GST on MDR @ 18%           -540
─────────────────────────────────
Net credited             1,46,460
```

So the loop is three-way — **Stage A** ties the bank credit to a settlement
batch by UTR, **Stage B** explodes the batch by payment and matches each to a
ledger invoice, **Stage C** verifies the arithmetic to the paisa.

### The pipeline

Cheapest work first, so the expensive tiers only ever see the residual:

| Tier | Method | Handles |
|---|---|---|
| 0 | Normalize | FX at each record's own transaction date |
| 1 | Exact | Identifier + exact amount |
| 2 | Fuzzy | Typos, reordered narrations, timing drift |
| 3 | Optimal assignment | Ambiguous many-to-one *(not yet built)* |
| 4 | LLM adjudication | The genuinely weird residual *(not yet built)* |
| 5 | Exception | Typed, honest "I don't know" |

### Why the headline metric is not match rate

A wrong auto-approved match is far more expensive than an honest exception,
because a wrong match is **invisible** — it surfaces at month-end close or in an
audit. An exception surfaces immediately and gets checked.

So the reported figure is coverage held at a precision target:

> **auto-clears 73.3% of the batch at 100% precision, and routes the rest with a
> typed reason.**

A 100% match rate would be a **red flag, not a win**: the generator injects
invoices with no valid counterpart, so the honest ceiling sits at 88.7%. A
system reporting 100% is guessing.

### Ablation

Each row re-runs the whole pipeline with one capability switched off, so the
deltas are measured rather than asserted:

| Config | Precision | Recall | Auto-clear |
|---|---|---|---|
| Exact only | 100.0% | 54.3% | 48.2% |
| + Fuzzy | 100.0% | 75.1% | 66.7% |
| + FX normalization | 100.0% | 77.5% | 68.7% |
| + Holiday-aware windows | 100.0% | 82.7% | 73.3% |
| + Optimal assignment | — | *step 2* | — |
| + LLM adjudication | — | *step 4* | — |

Holiday awareness is worth +5.2pp on its own: a settlement delayed past Gandhi
Jayanti *looks* three business days late but is exactly on time, and naive date
logic manufactures a false exception for every one.

---

## Layout

```
app/          Next.js App Router — dashboard and API routes
components/   UI, in the DECLUTTR design system
lib/
  datasets/   canonical schema, generator, ground truth
  engine/     matching tiers, tie-out, fee maths, pipeline
  eval/       scoring and ablation
  tools/      connectors (FX today; calendar and IFSC next)
  util/       RNG, holiday-aware date maths
scripts/      bench CLI
tests/        50 tests
```

Two structural rules the code holds to:

**Money is `bigint` in minor units, never a float.** `0.1 + 0.2 !== 0.3` under
IEEE-754, and in reconciliation that surfaces as a phantom ₹0.01 fee-math break.

**The pipeline cannot import ground truth.** The accuracy claim depends on the
matcher never seeing the answer key, so it is enforced by a module-graph
assertion in `tests/truth-isolation.test.ts` rather than by convention.

---

## Status

Steps 1–4 of 9 complete, plus the Berka scale benchmark pulled forward from
step 8. Working end-to-end: generator, exact/fuzzy/optimal-assignment matching,
three-way tie-out, fee verification, multi-seed ablation, audit trail,
dashboard, tool registry, LLM adjudication — and a second, real-data pipeline
proving **109,521 records/sec** across the full 1,062,791-row Berka dataset
(`npm run bench:berka`; see `DATA.md`).

Measured, not assumed: the multi-seed ablation showed the optimal-assignment
tier does not move accuracy on this data (see `lib/eval/ablation.ts`) — kept
in because a correct null result, reported honestly, is a stronger claim than
a cherry-picked win.

The tool registry (`lib/tools/`) wires FX, bank-holiday, and IFSC connectors
each in three honest modes (`live` / `fixture` / `unconfigured`), sharing their
fixture data with the synchronous matching engine so an agent tool call and the
engine's own fast path can never disagree. `live` mode is real, tested code
(via a mocked `fetch`) but unverified against the actual internet — this
build environment's egress proxy blocks all three target hosts; see `DATA.md`.

### Tier 4 — LLM adjudication (`lib/engine/adjudicate.ts`)

The genuinely ambiguous residual from tiers 1–3 goes to an LLM agent (Groq's
`openai/gpt-oss-120b` — not `llama-3.3-70b-versatile`, which Groq's own docs
list for migration). The agent gets the step-3 connectors as investigation
tools (`fx.convert`, `calendar.isBusinessDay`, `bank.lookupIFSC`) plus
`ledger.search`, and must conclude with `propose_match` or `flag_exception` —
the system prompt is explicit that declining is success, not failure, given a
wrong auto-approved match is the expensive, invisible failure mode this whole
project exists to avoid.

`reconcile()` is now async throughout the codebase. No `GROQ_API_KEY` is set in
this build environment (nor is `api.groq.com` reachable through its egress
proxy — confirmed, same denial as the step-3 hosts), so `agentTier` correctly
reports `skipped_no_key` here rather than fabricating a result. The agent loop
itself — tool-calling, refusal to guess, malformed-arguments handling,
mid-call network failure, the `maxAgentRecords` cost cap — is exercised in
`tests/adjudicate.test.ts` against a scripted mock `LLMClient`, independent of
whether a real key is ever configured.

### Step 5 — proof, on the dashboard

The confidence/coverage curve and unit-economics panel (`components/CalibrationChart.tsx`)
surface data the backend already computed in steps 1–4 — no new backend logic,
purely making the existing numbers visible. The curve is why the headline
auto-clear figure is what it is: precision and auto-clear trade off as the
threshold moves, and the marked operating point is the lowest threshold whose
precision still clears the 99.5% target.

Caught one real rendering bug while screenshotting it: the lines appeared to
stop mid-chart with the operating-point markers floating disconnected — not a
data problem (the underlying `curve` array was verified complete and correct
first) but recharts' default line-draw animation caught mid-transition.
Disabled animation on the chart; a static benchmark dashboard has no reason to
animate a line-draw, and it removes the same screenshot-timing risk for anyone
presenting this live.

The unit-economics panel has two states, and only one has been visually
verified: the honest "no agent activity" fallback (no `GROQ_API_KEY` here).
The populated-stats branch is unit-tested (`tests/adjudicate.test.ts`) and
reuses the already-verified `Stat` component, but has not been screenshotted
end to end — noted as an open gap, not silently assumed correct.

### Step 6 — legibility: Settlement Q&A + tool-call narration

`lib/qa/answer.ts` — RAG over the audit trail, closed-world by construction:
retrieval (`findRecordId`) only ever resolves to a record id that genuinely
exists in the loaded run, by substring match against ids actually present —
never a regex guess at what an id "should" look like. Answering degrades the
same way tier 4 does: a deterministic `templateAnswer` computed with no model
call is the floor; when a Groq key is configured, an LLM polishes the prose
but is told explicitly to use only the given per-record context, and any
live-call failure falls back to the template rather than erroring. `/api/qa`
and the `Settlement Q&A` dashboard card wire this in; example-question chips
prompt a first question before anyone has to guess the right phrasing.

Caught and fixed a real overclaim while screenshotting it, not after: the
answer for a tiers-1-3 record read "it checked whether the settlement date
fell on a bank holiday" — but tiers 1-3 compute synchronously in-process, so
there was no discrete per-record check to describe. That phrasing was
accidentally borrowed from `pipeline.ts`'s `toolsFor()`, which tags a decision
with `calendar.isBusinessDay` whenever holiday-awareness is enabled for the
*whole batch*, not because that specific comparison needed it — a capability
flag, not a call log. Tier 4's `toolsCalled`, by contrast, is genuinely a
per-record log from `adjudicate.ts`. `narrateTools()` now takes the deciding
tier and phrases accordingly: past-tense, specific ("it checked...") only for
`tier === 'agent'`, where it's true; present-tense, capability-level
("this tier runs with holiday-aware date scoring enabled for the batch — not
a per-record lookup...") for tiers 1-3, where that's what's actually going on.
Same helper feeds both the Q&A answer and a new line in the decision drawer,
so the two surfaces can't drift apart on this. Visually verified in both
places via a real server run + Playwright screenshot after the fix.

140 tests pass. Build and typecheck clean.

Next: exception copy in a controller's voice, then streaming UI, then the
remaining "polish" items — cash panel, BYO-CSV, Slack, integrations panel.
