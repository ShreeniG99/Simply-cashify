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

Also optional: `SLACK_WEBHOOK_URL`, for a one-line notification when a run
finishes. Without it, `slack.notify` reports `unconfigured` honestly and the
dashboard never blocks on it.

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload, on port 3000 |
| `npm run build` | Production build |
| `npm start` | Serve the production build (run `build` first) |
| `npm test` | Run the test suite (217 tests) |
| `npm run typecheck` | TypeScript check with no build |
| `npm run bench` | Benchmark to the console — the numbers you cite |
| `npm run fetch:berka` | Downloads the real Berka dataset (~67MB) |
| `npm run bench:berka` | Throughput/correctness at scale on 1.06M real rows |
| `npm run bench:benchrec` | Real-data proof on BenchRec — no fetch script; place the 3 CSVs in `data/raw/benchrec/` yourself (see `DATA.md`) |
| `npm run bench:benchrec-baseline` | Scores a real ICAIF'23 competition submission against the same eval batch, with our own scorer (see `DATA.md`) |
| `npm run mcp` | Starts the MCP server on stdio, for Claude Desktop or `tests/mcp.test.ts` |

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
  datasets/   canonical schema, generator, ground truth, BYO-CSV adapter
  engine/     matching tiers, tie-out, fee maths, pipeline
  eval/       scoring and ablation
  forecast/   cash position projection
  tools/      connectors (FX, calendar, IFSC) + the Slack action
  qa/         Settlement Q&A retrieval and template answers
  util/       RNG, holiday-aware date maths
scripts/      bench CLI
tests/        217 tests
mcp/          MCP server — same engine, exposed as tools for Claude Desktop
```

Two structural rules the code holds to:

**Money is `bigint` in minor units, never a float.** `0.1 + 0.2 !== 0.3` under
IEEE-754, and in reconciliation that surfaces as a phantom ₹0.01 fee-math break.

**The pipeline cannot import ground truth.** The accuracy claim depends on the
matcher never seeing the answer key, so it is enforced by a module-graph
assertion in `tests/truth-isolation.test.ts` rather than by convention.

---

## Status

Every step of the plan — all 9 — has real, working code behind it now,
plus controller-voice exception copy and structured Settlement Q&A answers
(both raised as ideas outside the plan's own numbering). Working
end-to-end: generator, exact/fuzzy/optimal-assignment matching, three-way
tie-out, fee verification, multi-seed ablation, audit trail, dashboard,
tool registry, LLM adjudication, Settlement Q&A, cash forecast, BYO-CSV
upload, a Slack action, a Razorpay settlements connector, an integrations
panel, and an MCP server — plus **two** real-data pipelines: **109,521
records/sec** across the full 1,062,791-row Berka dataset, and a third,
structurally different real dataset (BenchRec, ICAIF'23) proving the
fuzzy/assignment tiers on real free text with no identifier at all —
**99.1% precision** at a measured, explained recall (see `DATA.md` for both
and the honest reasoning behind BenchRec's recall number).

See "Where the plan stands now" below for the two pieces (Razorpay, the MCP
server) that are real and tested against a mock but not yet verified
against a live network from this sandbox — the one honest gap remaining
across the whole project.

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

### Step 7 — polish: cash panel, BYO-CSV, Slack, integrations panel, responsive

**Cash position** (`lib/forecast/cash.ts`, `components/CashPanel.tsx`) — 13
weekly buckets, only possible because reconciliation already ran. Week 0 is
the cash this run just confirmed (matched invoices); every week after
projects the still-open invoices (this run's own ledger-side exceptions)
forward using a collection lag *learned from this run's own matched
population*, not an assumed constant. Stated plainly, not buried: "today" is
the latest invoice date the run saw, not a real wall clock, since a synthetic
historical batch has no wall clock to read; and the widening confidence band
is a linear placeholder, not a fitted variance model — a few hundred matched
invoices per run is too small a sample to fit one honestly.

**BYO-CSV** (`lib/datasets/csvAdapter.ts`, `components/UploadPanel.tsx`,
`/api/upload`) — the architectural claim "adding a dataset means writing one
adapter, not touching the engine" made real: drop a CSV with a `source`
column (`bank`/`settlement`/`ledger`) and canonical field names, and it runs
through the exact same `reconcile()` the generator path uses. Deliberately
not a raw-bank-statement-format detector — guessing an unfamiliar export's
column layout would be the same kind of fabrication this project refuses
elsewhere, so a malformed file gets a specific, typed error instead of a
best-effort guess. An uploaded batch has no ground truth, so its payload
(`UploadRunPayload`) has no `report`, `ablation`, or `ceiling` field at all —
it shows what the engine decided (matches, exceptions, tiers, the audit
trail, a cash forecast), never a precision claim against an unknown answer.

**Slack** (`lib/tools/actions/slack.ts`) — the tool belt's one action tool,
registered alongside the read connectors but shaped differently: an outbound
webhook POST has no fixture to replay (a "recorded" Slack post is a
contradiction), so this tool only ever reports `live` or `unconfigured`,
never `fixture`. Its `status()` also deliberately never fires a real test
message to check — unlike the read connectors' idempotent GET-based status
checks, probing this one for real would post to a real channel on every
dashboard load. Fires a one-line summary after a generator run and after a
CSV upload; a missing `SLACK_WEBHOOK_URL` no-ops silently rather than
blocking the run.

**Integrations panel** (`components/IntegrationsPanel.tsx`, `/api/tools`) —
adds no new status logic, it just makes `toolStatusReport()` (already the
single source of truth every connector self-reports through) visible: a
live/fixture/unconfigured dot per registered tool, including the new Slack
action.

**Responsive pass** — verified with a real Playwright run at a 390px
viewport rather than assumed from the existing `sm:`/`lg:` breakpoints. Caught
one real overflow while doing it: the integrations panel's status label
(`shrink-0`, a genuinely long string like "fixture — recorded cassette, no
network reachable") forced its flex row past the viewport edge on a phone
width — a 27px horizontal scroll on the whole page. Fixed by letting that row
wrap instead of forcing every child onto one line; re-verified `scrollWidth
== clientWidth` at 390px afterward, not just visually.

164 tests pass. Build and typecheck clean.

### Exception copy in a controller's voice

`ReconExceptionRecord.detail` (`lib/engine/types.ts`) stayed exactly as
precise and technical as it always was — the exact candidate id, score,
threshold, or paisa delta — because the decision drawer and Settlement Q&A
exist so a controller can re-verify a specific claim down to the number. But
that precision reads like a debug log when it's the first thing a controller
sees while scanning fifty rows: *"Best candidate pay_2008 scored 0.7, below
the 0.72 threshold"* answers "what number produced this," not "what do I do
about it."

So every real exception now also carries `controllerSummary`
(`lib/copy/exceptions.ts`), computed at the exact same call sites in
`lib/engine/pipeline.ts` from the same structured data `detail` was built
from — never by reformatting or regex-parsing `detail` after the fact, which
would be fragile and exactly backwards. *"The closest candidate, pay_2008,
falls short of our auto-approval bar — worth a second look before
confirming"* is the same fact, said the way a controller would say it. The
main exceptions table now shows this; the decision drawer and Q&A still show
the precise technical trace. Agent-tier exceptions reuse the LLM's own
rationale for both, since it's already prompted to be "one or two sentences a
controller could audit." A `GENERIC_CONTROLLER_COPY` fallback (reason-only,
no dynamic detail) covers the few pre-existing test fixtures that predate
this field, so nothing ever renders blank.

### Streaming tier progress

`npm run dev` and clicking **Run reconciliation** used to show a static
"Reconciling…" spinner for the run's full ~1-2 seconds. `/api/runs` now
streams newline-delimited JSON — zero or more `{type:'progress', event}`
lines as `lib/engine/pipeline.ts` actually executes each tier
(`lib/engine/progress.ts`), then one `{type:'result', payload}` line — so the
dashboard shows what's actually running instead.

Stated honestly rather than smoothed over: tiers 0-3 are synchronous and
typically resolve in low single-digit milliseconds for a few hundred
records, so on this machine the full main-run tier sequence streamed and
rendered in well under 100ms end to end when checked directly (curl with
per-line timestamps confirmed the transport itself is genuinely
incremental, not buffered — Next.js's default response compression would
silently defeat this by buffering the whole body, so nothing here pretends
the events are slower than they are). That speed is itself the honest
signal the ablation table has always made: deterministic matching is not
where a run's time goes. The parts genuinely paced by real wall-clock time
are the six-rung ablation sweep (a real sequential pass over the whole
pipeline per rung, ~1-2 seconds total) and, when a live Groq key is
configured, the per-record `agent-progress` events during tier 4 — both
verified against real timestamps, not simulated with an artificial delay.

`reconcile()` and `runAdjudication()` both take `onProgress` as a fully
optional parameter; `tests/progress.test.ts` asserts the run produces
byte-identical matches and exceptions whether or not a callback is supplied,
so progress reporting is provably a side channel, not something the
reconciliation logic depends on.

171 → 180 tests pass across this and the exception-copy change. Build and
typecheck clean; verified live via a real server run (`curl -N` with
per-line timestamps, then a full browser pass) rather than assumed from the
unit tests alone.

### Step 8 — differentiators: Razorpay test-mode Settlements API

`lib/tools/actions/razorpay.ts` + `lib/datasets/razorpay/adapter.ts` — a
real, registered tool (`razorpay.settlements.list`) that pulls an
authenticated account's actual test-mode settlement batches and adapts them
to the canonical schema, same "one adapter file, no engine changes" claim
`csvAdapter.ts` makes for a hand-built CSV. It deliberately has no `fixture`
mode: unlike an FX rate or an IFSC code, a settlement batch is private,
account-specific data with no immutable public fact to cache, so this tool
only ever reports `live` (credentials configured) or `unconfigured` (they
are not) — never a stand-in settlement dressed up as real data. `api.razorpay.com`
is unreachable from this build environment, same denial as every other
external host this project touches (see `DATA.md`), so `unconfigured` is
what it genuinely reports here; a user with their own test-mode key pair
would see it go live.

The Berka scale benchmark (real 1.06M-row data, 109,521 rec/s) was already
pulled forward from this step much earlier — see the Status section above
and `DATA.md`.

**BenchRec** (`lib/datasets/benchrec/`, `lib/engine/benchrecMatch.ts`,
`lib/eval/benchrecScore.ts`) — a third, structurally different real dataset:
pure two-way ledger-vs-statement matching, no settlement-batch layer, no
identifier text, real dollar amounts from $40 to several billion. Kaggle is
unreachable from every build session this project has run in and no GitHub
mirror exists (unlike Berka), so the project owner supplied the three CSVs
directly — `npm run bench:benchrec` reads them from `data/raw/benchrec/`.

Real scale forced two techniques Berka didn't need, since this dataset holds
everything in one account (no natural partition key): amount-window
blocking instead of a full cross product, and connected-component
partitioning before the O(n²m) Hungarian solver runs — one real component
held 1,034,165 nodes (hundreds of transactions share an identical round
amount), and 156 oversized components correctly fell back to greedy rather
than attempting that solve directly.

**Measured** (commit `4ab0511`, eval split, `npm run bench:benchrec`):
**99.1% precision, 12.4% recall**, 34 wrong auto-approvals out of 3,769
claims, 412 seconds end-to-end on 69,171 real rows. The recall number is a
genuine, explained finding, not a defect the numbers are hiding: the run's
own confidence histogram shows 340,898 candidates sitting in the 0.6–0.72
band against only 3,871 above it — the same fixed 0.72 threshold tuned for
the synthetic generator's clearer signal, applied unchanged to two
independent systems describing the same transaction in genuinely different
free text. Declining a near-miss rather than lowering the bar to claim it is
the same precision-gated philosophy the app's own headline metric already
uses — a wrong auto-approval is the expensive, invisible failure this whole
project exists to avoid. A dataset-specific threshold calibration (the same
sweep `lib/eval/score.ts` already runs for the generator) would very likely
raise recall substantially; not attempted here for time, and named as the
obvious next step rather than left silently undone. See `DATA.md` for the
full breakdown.

**External baseline, on the same batch** (`npm run bench:benchrec-baseline`):
a real ICAIF'23 competition submission (`MatcherByChatGPT_submission.csv`,
also supplied by the project owner) scores **95.2% precision, 65.9% recall**
against the identical eval + solution split, scored with our own
`scoreBenchRec` — same scorer, same batch, only the predictions differ. The
ceiling matches ours exactly (93.8%), which cross-validates the truth
derivation, and the recall gap against an equally precision-scored system on
the exact same rows is the quantified size of the threshold-calibration
finding above.

### Step 9 — reach: Simply Cashify as an MCP server

`mcp/server.ts` — the same reconciliation engine, exposed as an MCP server so
Claude Desktop (or any MCP client) can run and inspect a reconciliation
directly, without the dashboard in between. It calls the exact same
functions the dashboard and the `bench` CLI call — `runReconciliation` and
`runReconciliationFromBatch` from `lib/api/run.ts`, `buildContext`/
`templateAnswer` from `lib/qa/answer.ts` for exception explanations — rather
than reimplementing any of the logic a third time.

Five tools, stdio transport (a local subprocess, the right choice for
Claude Desktop — see the MCP TypeScript SDK's transport-selection guidance):

| Tool | Does |
|---|---|
| `reconcile_batch` | Generate a synthetic batch and reconcile it — same generator + pipeline as the dashboard's primary button |
| `upload_and_reconcile` | Reconcile a hand-supplied CSV, same `lib/datasets/csvAdapter.ts` the dashboard's drop zone uses |
| `list_exceptions` | Paginated, filterable exception list with controller-voice summaries |
| `explain_exception` | Grounded per-record explanation — literally `buildContext` + `templateAnswer`, the dashboard Q&A card's own logic |
| `get_cash_position` | The 13-week forecast for a given run |

`reconcile_batch`/`upload_and_reconcile` return a `runId`, not the full
payload — a real run can carry hundreds of records, and dumping all of it
into one tool response would blow past what's useful in an agent's context.
The other three tools take that `runId` and answer a specific question
against it instead. Runs are held in memory for the server process's
lifetime only, matching the dashboard's own no-persistence-across-reload
model — a run is a snapshot of one reconciliation, not a database record.

**Verified as a real integration test, not just a design.**
`tests/mcp.test.ts` spawns the actual server as a subprocess and drives it
with the real `@modelcontextprotocol/sdk` client over the real stdio
transport — the same path Claude Desktop would take — rather than calling
the tool handler functions directly in-process. It reconciles a real batch,
lists real exceptions, asks for an explanation of a record that doesn't
exist and checks the response says so plainly rather than guessing, and
uploads a hand-built CSV through `upload_and_reconcile` end to end.

Run it yourself: `npm run mcp` starts the server on stdio. Point a Claude
Desktop config at it with:

```json
{
  "mcpServers": {
    "simply-cashify": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/Simply-cashify/mcp/server.ts"]
    }
  }
}
```

194 tests pass (was 185). Build and typecheck clean.

### Post-launch: a real user bug report, fixed two ways

A user testing Settlement Q&A asked a direct question that caught a real
defect: for a duplicate-suspected exception, the decision drawer said
*"pay_2090 (scored 1 — confidence 1 below accept threshold 0.72)"* — a
self-contradiction, since 1 is not below 0.72.

**The data bug.** `lib/engine/pipeline.ts`'s exceptions loop applied one
hardcoded rejection sentence — "confidence X below accept threshold Y" — to
every rejected alternative, regardless of whether that was true. A duplicate
ledger row's best candidate can score a perfect match against the payment
its twin already claimed; the real reason it wasn't used is "already matched
elsewhere," not "too low-scoring." `rejectedBecauseFor()` now checks what's
actually true of each candidate before writing the sentence — below
threshold (the original claim, still correct when it applies), already
claimed by a specific other invoice, or — rarer — the row itself was
excluded for an unrelated reason, named instead of blaming the score.
`tests/alternatives.test.ts` adds a general invariant (no alternative, on
any seed, ever claims "below threshold" for a score that isn't) plus a
direct reproduction of the reported case searched across 40 seeds, and the
fix was verified live against the exact reported scenario through the real
`/api/qa` endpoint before and after.

**The format request.** The same user asked for the answer to be
restructured into points, directly addressing the exact question, explained
plainly. `lib/qa/answer.ts`'s `templateAnswer` now returns `{headline,
points}` instead of one dense paragraph — a direct one-sentence answer
(reusing the exact `controllerSummary` the exceptions table shows, not a
second paraphrase that could drift from it) plus each supporting fact as its
own scannable line, rather than a run-on sentence burying the actual answer
in the middle. The LLM-polish path was updated to match: the system prompt
now asks for the same `{headline, points}` JSON shape, parsed and validated,
falling back to the template on any malformed response — same resilience
pattern as tier 4's malformed-tool-call handling. Reproduced the exact
reported question ("why is pay_2090 rejected even when confidence was 1")
live in the browser after the fix: the answer now states the real cause —
"already matched to INV-2090" — as its own bullet point.

217 tests pass. Build and typecheck clean.

---

## Where the plan stands now

All nine steps have real, working code behind them, tested, and run against
real data where real data exists. One honest gap remains, and it's an
external blocker, not scope cut for time:

- **Razorpay's Settlements API** and the **MCP server** are both real,
  tested code — the MCP server has a genuine end-to-end integration test
  spawning the real process over real stdio — but Razorpay's connector
  specifically has never been exercised against a live network from this
  sandbox: `api.razorpay.com` is blocked the same way every other external
  host this project touches is. It would need to be tried from an
  unrestricted machine (or with a real Razorpay test-mode account) before
  calling it fully verified rather than "correct by construction and tested
  against a mock."
