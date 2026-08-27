# Facts — every external claim, with its source

**Rule: if a number is not in this file, do not put it in the README, the video, or a
code comment.** Ask instead. Every claim in this project must survive a hostile check,
because the project's entire thesis is honesty about what is real.

Tags: **[V]** verified against a primary or named source · **[A]** assumption we chose,
labelled as such · **[O]** our own measured output

Last checked: 27 August 2026.

---

## 1. The gap — agentic commerce has no merchant-side trust

**[V]** All six major agentic commerce standards specify **agent → merchant** trust.
None specifies the reverse. Tabulated across ACP (OpenAI/Stripe), UCP (Google/Shopify),
AP2 (Google), Visa Intelligent Commerce / Trusted Agent Protocol, Mastercard Agent Pay,
and x402 (Coinbase).
→ https://www.agenticfuturesinitiative.org/afi-standards.html

**[V]** Visa's own threat analysis states AI shopping agents *"can be deceived by
sophisticated counterfeit merchants engineered specifically to exploit them,"* and that
*"a fraudulent storefront may look entirely legitimate, pass automated security checks,
and offer prices far below market rate."* Visa then shipped Trusted Agent Protocol,
which lets **merchants verify agents** — the opposite direction.
→ https://corporate.visa.com/en/sites/visa-perspectives/security-trust/the-threats-landscape-of-agentic-commerce.html

**[V]** Merchant risk scoring exists but is sold only to acquirers — Mastercard Merchant
Risk Predict, Sardine. Nothing exposes it to a third-party buying agent.
→ https://b2b.mastercard.com/ai-and-security-solutions/ai-network-solutions/merchant-risk-predict/
→ https://www.sardine.ai/merchant-risk

*Use this framing:* the gap is **distribution, not invention**. The data and models
exist inside the acquiring stack; nobody has built the agent-readable surface.

---

## 2. Agentic commerce — actual size, mid-2026

Use these to be honest that the market is early. **Do not inflate them.**

- **[V]** ~**3%** of transactions currently involve an AI agent, against 89% of merchants
  claiming active preparation.
- **[V]** Measured autonomous checkout ≈ **$20.6 billion**, about **1.5%** of US
  e-commerce in 2026.
- **[V]** **65%** of consumers trust AI to compare prices; **14%** trust it to complete
  a purchase autonomously — a 51-point permission gap.
- **[V]** Shopify: AI-referred traffic up **8×** YoY in Q1 2026; AI-referred orders up
  nearly **13×** in the same period.
- **[V]** Adobe: **393%** YoY growth in Q1 2026, with conversion moving from 38% *worse*
  than baseline (March 2025) to **42% better** (March 2026).
→ https://www.digitalapplied.com/blog/agentic-commerce-statistics-2026-data
→ https://atxp.ai/blog/agentic-commerce-stats-2026/

*Honest framing:* small today, growing fast, and conversion has crossed baseline.

---

## 3. India context

**[V]** Razorpay, NPCI and OpenAI launched agentic payments in October 2025 on UPI Circle
and UPI Reserve Pay, with BigBasket as first merchant.
→ https://newsroom.razorpay.in/newsroom/razorpay-npci-and-openai-come-together-to-launch-agentic-payments-ushering-in-ai-driven-commerce-at-national-scale/

**[V]** Razorpay + NPCI agentic UPI on Claude, February 2026 — Zomato, Swiggy, Zepto live,
described by Razorpay as *"in a pilot phase with a select group of users."*
→ https://razorpay.com/blog/agentic-payments-and-npci/

**[V]** NPCI's Unified Agent Protocol was reported in July 2026 as **under development,
pending RBI approval**, with no published spec. Its stated purpose is to verify the
**agent** — not the merchant.
→ https://www.business-standard.com/finance/news/india-may-allow-agentic-ai-led-upi-transactions-under-new-npci-protocol-126070801343_1.html

⚠️ **Do not claim any integration with NPCI, UAP, UPI Reserve Pay, ACP, UCP or AP2.**
They are the motivation for the gap. Nothing in this project implements them.

---

## 4. Our own repo's measured numbers

**[O]** Generator batch: auto-clears **73.3%** at **100% precision**; honest ceiling is
**88.7%** because the generator injects invoices with no valid counterpart.

**[O]** Berka (real, 1,062,791 rows): **109,521 records/sec** end to end.

**[O]** BenchRec (real, labelled, 69,171 rows): **99.1% precision at 12.4% recall**, with
34 wrong auto-approvals out of 3,769 claims, in 412 seconds — against a published
ICAIF'23 submission on the same batch at **95.2% precision, 65.9% recall**.

**[O]** 217 tests passing.

*These are ours and they are real. Quote them exactly; do not round them upward.*

---

## 4b. "Why not real data?" — the prepared answer

**[V]** The base engine is already scored on two real datasets: **Berka** (1,062,791 rows)
and **BenchRec** (69,171 rows, labelled, with a published ICAIF'23 baseline to compare
against). Real data is not absent from this project.

**[V/O]** What does not exist publicly is a dataset shaped like *many merchants × matched
bank/settlement/ledger × a labelled trust outcome*. That combination is proprietary to
payment processors and acquirers. This is a structural gap, not a search failure.

**Olist (Brazilian e-commerce) was evaluated and rejected**, deliberately:
- Licensed **CC BY-NC-SA 4.0** — non-commercial, a real constraint rather than a footnote
- Hand-picking merchants into personality buckets **relocates circularity** rather than removing it
- Its review-score signal contradicts this project's thesis — reviews are fakeable, which
  is the whole reason to use reconciliation instead
- It does not address the AI-judgment question, which was the actual gap

*Say this if asked. A rejected dataset with stated reasons is a stronger answer than a
compromised one.*

---

## 5. Assumptions we are choosing — label every one

**[A]** Component **priors and the recency-decay half-life** are chosen and disclosed, not
fitted on outcomes. The scoring itself is a Beta-Bernoulli posterior with a conservative
lower bound — so the *combination* rule is principled, but the priors are still ours.
Every tool response carries this caveat in its payload, not in a footnote.

**[A]** `insufficient_history` fires when the credible interval is too wide to place a
merchant in a single band, plus a hard floor on n. Both parameters are **pinned in config
before any score is computed** — setting them after seeing results would be generator
tuning in a different costume.

**[A]** Cost of a wrong trust call, in both directions, comes from named constants in
the code, commented as assumptions — not measured.

**[A]** Reconciliation health as a proxy for merchant trustworthiness is a **hypothesis**.
Nobody has validated that it predicts merchant misbehaviour. It is defensible, not proven.

**[A]** The minimum record count below which a merchant is `insufficient_history` is a
chosen threshold, disclosed.

---

## 6. Claims that must NEVER be made

- ✗ That this implements or complies with ACP, UCP, AP2, UAP or any payment protocol
- ✗ That real Razorpay merchant data was used — **it was not; all merchants are synthetic**
- ✗ That the Razorpay integration was live-tested, if it ran in `fixture` or
  `unconfigured` mode. Say which mode it ran in.
- ✗ Any accuracy figure presented as real-world merchant accuracy
- ✗ That Razorpay endorses, reviewed or supplied anything
- ✗ Any statistic not in this file
- ✗ That tier 4 decides anything binding — **it advises; the gate bounds the money**, and
  tier 4 may only hold or lower a band, never raise one

---

## 7. Things to re-verify before they go on camera

- Whether Razorpay test-mode Orders API behaved as documented **from your machine** —
  report the mode the tool actually returned
- The exact wording of the Track 01 brief at https://razorpay.com/buildathon/
- The submission deadline and time
