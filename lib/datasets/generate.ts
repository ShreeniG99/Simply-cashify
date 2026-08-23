/**
 * Razorpay-shaped synthetic batch generator.
 *
 * This is the *instrument*, not merely a data source: every discrepancy class is
 * dialled independently so the exception list can be diagnosed per class rather
 * than reported as an undifferentiated pile. It also supplies the batch shape no
 * public dataset has — one UTR credit covering N payments, net of MDR and
 * GST-on-MDR, plus refund adjustments.
 *
 * Emits the batch and the ground truth as two separate values. The caller hands
 * only the batch to the pipeline.
 */

import {
  type CanonicalBatch,
  type CanonicalRecord,
  toMinor,
} from './canonical'
import {
  type DiscrepancyClass,
  type GroundTruth,
  type TruthPair,
  type TruthTieout,
  countClasses,
} from './truth'
import { makeRng, type Rng } from '../util/rng'
import { IN_FIXED_HOLIDAYS_2026, addBusinessDays, addDays } from '../util/dates'

/** MDR (gateway fee) as a percentage of gross. */
const MDR_PERCENT = 2n
/** GST charged on the MDR, not on the gross. */
const GST_ON_MDR_PERCENT = 18n

/**
 * FX snapshot used by the generator. The FX connector's cassette is seeded from
 * these same numbers so a generated batch and a replayed conversion agree.
 */
export const GENERATOR_FX_RATES: Record<string, number> = {
  USD: 87.42,
  EUR: 94.15,
}

const COUNTERPARTIES = [
  'ACME CORP PVT LTD',
  'NIMBUS RETAIL',
  'SARAVANA TRADERS',
  'BLUEPEAK LOGISTICS',
  'KAVERI FOODS PVT LTD',
  'ORION SOFTWARE LABS',
  'MEENAKSHI TEXTILES',
  'VERTEX HEALTHCARE',
  'PRAGATI MOTORS',
  'INDUS CLOUD SERVICES',
  'RANGOLI HANDICRAFTS',
  'SUMMIT EDUTECH',
] as const

const IFSC_CODES = [
  'HDFC0000001',
  'ICIC0000123',
  'SBIN0001234',
  'UTIB0000456',
  'KKBK0000789',
  'YESB0000321',
] as const

export type GenerateOptions = {
  seed: number
  /** Ledger invoices to produce, before duplicates are added. Default 180. */
  invoiceCount?: number
  baseCurrency?: string
}

export type GeneratedDataset = {
  batch: CanonicalBatch
  truth: GroundTruth
}

/** Distribution of injected classes. Explicit counts keep runs diagnosable. */
function classPlan(total: number): DiscrepancyClass[] {
  const spec: [DiscrepancyClass, number][] = [
    ['true_orphan', Math.round(total * 0.067)],
    ['ambiguous_near_duplicate', Math.round(total * 0.056)],
    ['split_settlement', Math.round(total * 0.044)],
    ['partial_refund', Math.round(total * 0.056)],
    ['fx_settlement', Math.round(total * 0.067)],
    ['holiday_delayed', Math.round(total * 0.056)],
    ['timing_drift', Math.round(total * 0.089)],
    ['typo_reference', Math.round(total * 0.078)],
    ['wrong_ifsc', Math.round(total * 0.033)],
  ]
  const plan: DiscrepancyClass[] = []
  for (const [cls, n] of spec) for (let i = 0; i < n; i++) plan.push(cls)
  // ambiguous pairs must come in twos
  const ambiguous = plan.filter((c) => c === 'ambiguous_near_duplicate').length
  if (ambiguous % 2 === 1) plan.push('ambiguous_near_duplicate')
  while (plan.length < total) plan.push('clean')
  return plan.slice(0, total)
}

type Invoice = {
  rec: CanonicalRecord
  cls: DiscrepancyClass
  /** Gross value in INR minor units, whatever currency the invoice is raised in. */
  inrAmount: bigint
  /**
   * Whether the settlement narration quotes the invoice reference.
   *
   * Real bank narrations frequently do NOT — which is the whole reason
   * reconciliation is hard. If every payment quoted its invoice number, a
   * dictionary lookup would solve the problem and there would be nothing to
   * build. Classes that are meant to be difficult (ambiguous near-duplicates,
   * holiday-delayed) always omit it, plus a slice of ordinary traffic.
   */
  refOnSettlement: boolean
}

export function generate(opts: GenerateOptions): GeneratedDataset {
  const seed = opts.seed
  const invoiceCount = opts.invoiceCount ?? 180
  const baseCurrency = opts.baseCurrency ?? 'INR'
  const rng = makeRng(seed)
  const holidays = [...IN_FIXED_HOLIDAYS_2026]

  const plan = rng.shuffle(classPlan(invoiceCount))
  const invoices = buildInvoices(plan, rng)

  const ledger: CanonicalRecord[] = invoices.map((i) => i.rec)
  const settlements: CanonicalRecord[] = []
  const bank: CanonicalRecord[] = []
  const pairs: TruthPair[] = []
  const tieouts: TruthTieout[] = []

  // Invoices that never settle: no payment row is ever produced for them.
  for (const inv of invoices.filter((i) => i.cls === 'true_orphan')) {
    pairs.push({ ledgerId: inv.rec.id, paymentIds: [], class: 'true_orphan' })
  }

  const settleable = invoices.filter((i) => i.cls !== 'true_orphan')
  const batches = groupIntoBatches(settleable, rng)

  let batchNo = 0
  for (const group of batches) {
    batchNo++
    const batchId = `setl_${String(batchNo).padStart(4, '0')}`
    const utr = makeUtr(rng)
    const settlementDate = settlementDateFor(group, holidays)

    const payments: CanonicalRecord[] = []

    for (const inv of group) {
      const isSplit = inv.cls === 'split_settlement'
      // A split invoice contributes ~60% here; the remainder is paid in a later
      // batch, appended after the main loop.
      const portion = isSplit ? (inv.inrAmount * 60n) / 100n : inv.inrAmount
      const pay = makePayment({
        rng,
        batchId,
        utr,
        date: settlementDate,
        amount: portion,
        inv,
        suffix: isSplit ? 'a' : '',
      })
      payments.push(pay)

      if (!isSplit) {
        pairs.push({ ledgerId: inv.rec.id, paymentIds: [pay.id], class: inv.cls })
      } else {
        // completed once the second leg is emitted below
        pairs.push({ ledgerId: inv.rec.id, paymentIds: [pay.id], class: 'split_settlement' })
      }

      if (inv.cls === 'partial_refund') {
        payments.push(
          makeRefund({ rng, batchId, utr, date: settlementDate, inv, of: portion }),
        )
      }
    }

    settlements.push(...payments)
    bank.push(makeBankCredit({ batchId, utr, date: settlementDate, payments }))
    tieouts.push({ bankId: `bank_${batchId}`, settlementBatchId: batchId })
  }

  // Second leg of every split settlement, in its own later batch.
  const splits = settleable.filter((i) => i.cls === 'split_settlement')
  if (splits.length > 0) {
    const chunks = chunk(splits, 4)
    for (const group of chunks) {
      batchNo++
      const batchId = `setl_${String(batchNo).padStart(4, '0')}`
      const utr = makeUtr(rng)
      const settlementDate = addBusinessDays(settlementDateFor(group, holidays), 3, holidays)
      const payments: CanonicalRecord[] = []
      for (const inv of group) {
        const remainder = inv.inrAmount - (inv.inrAmount * 60n) / 100n
        const pay = makePayment({
          rng,
          batchId,
          utr,
          date: settlementDate,
          amount: remainder,
          inv,
          suffix: 'b',
        })
        payments.push(pay)
        const existing = pairs.find((p) => p.ledgerId === inv.rec.id)
        if (existing) existing.paymentIds.push(pay.id)
      }
      settlements.push(...payments)
      bank.push(makeBankCredit({ batchId, utr, date: settlementDate, payments }))
      tieouts.push({ bankId: `bank_${batchId}`, settlementBatchId: batchId })
    }
  }

  // Duplicate ledger entries: a second row for an invoice that was only paid
  // once. Correct behaviour is to suppress it, not to match it.
  const duplicateTargets = rng
    .shuffle(settleable.filter((i) => i.cls === 'clean'))
    .slice(0, Math.max(1, Math.round(invoiceCount * 0.055)))
  for (const target of duplicateTargets) {
    const dup: CanonicalRecord = {
      ...target.rec,
      id: `${target.rec.id}-DUP`,
      raw: { ...target.rec.raw, duplicate_of: target.rec.id },
    }
    ledger.push(dup)
    pairs.push({
      ledgerId: dup.id,
      paymentIds: [],
      class: 'duplicate_entry',
      duplicateOf: target.rec.id,
    })
  }

  // A couple of bank credits with no settlement behind them, so Stage A has
  // genuine orphans too.
  for (let i = 0; i < 2; i++) {
    const id = `bank_unmatched_${i + 1}`
    bank.push({
      id,
      source: 'bank',
      date: addDays('2026-10-05', i * 4),
      amount: toMinor(rng.int(4000, 90000)),
      currency: baseCurrency,
      reference: makeUtr(rng),
      memo: 'INWARD CREDIT - NARRATION UNAVAILABLE',
      raw: { note: 'no corresponding settlement' },
    })
    tieouts.push({ bankId: id, settlementBatchId: null })
  }

  const batch: CanonicalBatch = {
    datasetId: `generated-${seed}`,
    baseCurrency,
    bank,
    settlements,
    ledger,
  }

  const truth: GroundTruth = {
    datasetId: batch.datasetId,
    seed,
    tieouts,
    pairs,
    classCounts: countClasses(pairs),
  }

  return { batch, truth }
}

// ---------------------------------------------------------------- invoices

function buildInvoices(plan: DiscrepancyClass[], rng: Rng): Invoice[] {
  const invoices: Invoice[] = []
  let n = 0

  for (let idx = 0; idx < plan.length; idx++) {
    const cls = plan[idx]

    // Ambiguous pairs are emitted together so they share an amount and sit on
    // adjacent dates — the configuration where greedy first-fit mis-assigns.
    if (cls === 'ambiguous_near_duplicate') {
      const partnerIdx = plan.indexOf('ambiguous_near_duplicate', idx + 1)
      if (partnerIdx !== -1) {
        const amount = toMinor(rng.int(20000, 80000))
        const date = randomInvoiceDate(rng)
        invoices.push(makeInvoice(++n, cls, rng, { amount, date }))
        invoices.push(makeInvoice(++n, cls, rng, { amount, date: addDays(date, 1) }))
        plan[partnerIdx] = 'clean' // consumed
      } else {
        invoices.push(makeInvoice(++n, 'clean', rng, {}))
      }
      continue
    }

    invoices.push(makeInvoice(++n, cls, rng, {}))
  }

  return invoices
}

function makeInvoice(
  n: number,
  cls: DiscrepancyClass,
  rng: Rng,
  override: { amount?: bigint; date?: string },
): Invoice {
  const id = `INV-${String(2000 + n)}`
  const counterparty = rng.pick(COUNTERPARTIES)
  const ifsc = cls === 'wrong_ifsc' ? corruptIfsc(rng) : rng.pick(IFSC_CODES)

  // Holiday-delayed invoices sit just before Gandhi Jayanti (2026-10-02) so
  // their T+2 window straddles it.
  //
  // The holiday must fall on a WEEKDAY or this class is inert: Independence Day
  // 2026 is a Saturday, so using it would add no delay beyond the weekend and
  // the holiday-aware ablation row would show no gain. 2026-10-02 is a Friday,
  // so Thu -> next business day is Mon and the settlement genuinely looks late.
  const date =
    override.date ??
    (cls === 'holiday_delayed' ? rng.pick(['2026-09-30', '2026-10-01']) : randomInvoiceDate(rng))

  const inrAmount = override.amount ?? toMinor(rng.int(5000, 250000))

  let currency = 'INR'
  let amount = inrAmount
  if (cls === 'fx_settlement') {
    currency = rng.pick(['USD', 'EUR'])
    const rate = GENERATOR_FX_RATES[currency]
    // Raise the invoice in foreign currency; the INR figure stays the anchor.
    amount = BigInt(Math.round(Number(inrAmount) / rate))
  }

  // A typo damages the reference FIELD as well as the narration. Corrupting
  // only the memo would be inert: the matcher reads both, finds the pristine
  // field, and the class never bites.
  const reference = cls === 'typo_reference' ? corruptRef(rng, id) : id
  const memo =
    cls === 'typo_reference'
      ? typoMemo(rng, ifsc, counterparty, reference)
      : `NEFT-${ifsc}-${counterparty}-${reference}`

  // Hard classes never get a quoted reference on the settlement side; ordinary
  // traffic omits it about a third of the time.
  const refOnSettlement =
    cls === 'ambiguous_near_duplicate' || cls === 'holiday_delayed'
      ? false
      : !rng.chance(0.32)

  return {
    cls,
    inrAmount,
    refOnSettlement,
    rec: {
      id,
      source: 'ledger',
      date,
      amount,
      currency,
      reference,
      counterparty,
      memo,
      ifsc,
      raw: { invoice_no: id },
    },
  }
}

/** Invoice window: 2026-09-01 .. 2026-10-11, so it brackets Gandhi Jayanti. */
function randomInvoiceDate(rng: Rng): string {
  return addDays('2026-09-01', rng.int(0, 40))
}

/** Transpose two digits, or drop one — the shapes a keyed-in reference takes. */
function corruptRef(rng: Rng, ref: string): string {
  return ref.replace(/(\d)(\d)/, (_m, a, b) => (rng.chance(0.5) ? `${b}${a}` : `${a}`))
}

/** Reorder tokens — what a real bank narration looks like. */
function typoMemo(rng: Rng, ifsc: string, counterparty: string, ref: string): string {
  const tokens = rng.shuffle([counterparty, ref, ifsc, 'PAYMENT'])
  return `NEFT-${tokens.join('-')}`
}

function corruptIfsc(rng: Rng): string {
  const base = rng.pick(IFSC_CODES)
  return base.slice(0, 4) + 'X' + base.slice(5)
}

// ------------------------------------------------------------- settlements

function groupIntoBatches(invoices: Invoice[], rng: Rng): Invoice[][] {
  const shuffled = rng.shuffle(invoices)
  const batches: Invoice[][] = []
  let i = 0
  while (i < shuffled.length) {
    const size = rng.int(3, 6)
    batches.push(shuffled.slice(i, i + size))
    i += size
  }
  return batches
}

/** T+2 business days from the latest invoice date in the batch. */
function settlementDateFor(group: Invoice[], holidays: readonly string[]): string {
  const latest = group.reduce((acc, i) => (i.rec.date > acc ? i.rec.date : acc), group[0].rec.date)
  return addBusinessDays(latest, 2, holidays)
}

function makePayment(args: {
  rng: Rng
  batchId: string
  utr: string
  date: string
  amount: bigint
  inv: Invoice
  suffix: string
}): CanonicalRecord {
  const { rng, batchId, utr, inv, suffix } = args
  const paymentId = `pay_${inv.rec.id.replace('INV-', '')}${suffix}`

  // Timing drift pushes the payment past the normal window without a holiday
  // to explain it.
  const date = inv.cls === 'timing_drift' ? addDays(args.date, rng.int(1, 3)) : args.date

  const fees = (args.amount * MDR_PERCENT) / 100n
  const tax = (fees * GST_ON_MDR_PERCENT) / 100n

  // When the narration omits the reference, matching has to fall back on
  // amount, date and counterparty — which is where tiers 2-4 earn their keep.
  const memo = inv.refOnSettlement
    ? `${utr} SETTLEMENT ${inv.rec.reference ?? ''}`.trim()
    : `${utr} SETTLEMENT ${inv.rec.counterparty ?? ''}`.trim()

  return {
    id: paymentId,
    source: 'settlement',
    date,
    amount: args.amount,
    currency: 'INR',
    reference: paymentId,
    counterparty: inv.rec.counterparty,
    memo,
    parentId: batchId,
    fees,
    tax,
    ifsc: inv.cls === 'wrong_ifsc' ? undefined : inv.rec.ifsc,
    raw: {
      settlement_id: batchId,
      payment_id: paymentId,
      utr,
      ...(inv.refOnSettlement ? { invoice_hint: inv.rec.reference } : {}),
    },
  }
}

function makeRefund(args: {
  rng: Rng
  batchId: string
  utr: string
  date: string
  inv: Invoice
  of: bigint
}): CanonicalRecord {
  const { rng, batchId, utr, date, inv } = args
  const amount = -((args.of * BigInt(rng.int(10, 35))) / 100n)
  const id = `rfnd_${inv.rec.id.replace('INV-', '')}`
  return {
    id,
    source: 'settlement',
    date,
    amount,
    currency: 'INR',
    reference: id,
    counterparty: inv.rec.counterparty,
    memo: `${utr} REFUND ADJUSTMENT ${inv.rec.reference ?? ''}`.trim(),
    parentId: batchId,
    fees: 0n,
    tax: 0n,
    raw: { settlement_id: batchId, refund_id: id, utr, adjusts: inv.rec.reference },
  }
}

/**
 * The single bank line a controller actually sees:
 * `gross − fees − tax ± refunds = net credited`.
 */
function makeBankCredit(args: {
  batchId: string
  utr: string
  date: string
  payments: CanonicalRecord[]
}): CanonicalRecord {
  const gross = args.payments.reduce((a, p) => a + p.amount, 0n)
  const fees = args.payments.reduce((a, p) => a + (p.fees ?? 0n), 0n)
  const tax = args.payments.reduce((a, p) => a + (p.tax ?? 0n), 0n)
  const net = gross - fees - tax

  return {
    id: `bank_${args.batchId}`,
    source: 'bank',
    date: args.date,
    amount: net,
    currency: 'INR',
    reference: args.utr,
    memo: `RAZORPAY SETTLEMENT ${args.utr}`,
    raw: {
      utr: args.utr,
      gross: gross.toString(),
      fees: fees.toString(),
      tax: tax.toString(),
      net: net.toString(),
    },
  }
}

function makeUtr(rng: Rng): string {
  let digits = ''
  for (let i = 0; i < 15; i++) digits += rng.int(0, 9)
  return `N${digits}`
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
