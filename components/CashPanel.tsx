'use client'

import { Area, Bar, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { RunPayload } from '@/lib/api/run'
import { ScrollX } from './ui'

/**
 * Cash position — 13 weekly numbers, not a calendar.
 *
 * Only possible because reconciliation already ran: week 0 is the cash this
 * run just confirmed (matched invoices), every week after projects the
 * still-open invoices (this run's ledger-side exceptions) forward using a
 * collection lag learned from this run's own matched population. See
 * lib/forecast/cash.ts for the honesty limits — "today" is the edge of known
 * data in this batch, and the confidence band is a linear placeholder, not a
 * fitted distribution.
 */
export function CashPanel({ forecast }: { forecast: RunPayload['cashForecast'] }) {
  const f = forecast
  const data = f.weeks.map((w) => ({
    label: `wk ${w.weekIndex}`,
    confirmed: w.confirmedValue,
    projected: w.projectedValue,
    bandLow: w.bandLowValue,
    bandWidth: w.bandHighValue - w.bandLowValue,
    cumulative: w.cumulativeValue,
  }))

  return (
    <div>
      <p className="font-mono text-xs leading-relaxed text-text-secondary">
        As of <span className="text-text-primary">{f.asOf}</span> — the latest invoice date this
        run saw, not a real wall clock.{' '}
        {f.lagSampleSize > 0 ? (
          <>
            Open invoices are projected forward{' '}
            <span className="text-text-primary">{f.collectionLagDays} days</span>, the median lag
            learned from <span className="text-text-primary">{f.lagSampleSize}</span> matched
            invoices in this run.
          </>
        ) : (
          <>
            No matches to learn a lag from this run, so open invoices fall back to a fixed{' '}
            <span className="text-text-primary">{f.collectionLagDays}-day</span> assumption.
          </>
        )}{' '}
        The shaded band widens linearly with distance — a placeholder shape, not a fitted
        variance model; this run's sample is too small to fit one honestly.
      </p>

      <div className="mt-4 h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
            <XAxis
              dataKey="label"
              tick={{ fill: '#8A8A96', fontFamily: 'DM Mono', fontSize: 11 }}
              stroke="#2A2A2E"
            />
            <YAxis
              tick={{ fill: '#8A8A96', fontFamily: 'DM Mono', fontSize: 11 }}
              stroke="#2A2A2E"
              width={56}
              tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip
              contentStyle={{
                background: '#161618',
                border: '1px solid #2A2A2E',
                borderRadius: 8,
                fontFamily: 'DM Mono',
                fontSize: 12,
              }}
              labelStyle={{ color: '#8A8A96' }}
              formatter={(value: number, name: string) => [
                `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
                { confirmed: 'confirmed', projected: 'projected', cumulative: 'cumulative' }[
                  name
                ] ?? name,
              ]}
            />
            {/* Stacked invisible base + visible band, so the shading floats at bandLow..bandHigh. */}
            <Area
              dataKey="bandLow"
              stackId="band"
              stroke="none"
              fill="transparent"
              isAnimationActive={false}
              legendType="none"
            />
            <Area
              dataKey="bandWidth"
              stackId="band"
              stroke="none"
              fill="#7B61FF"
              fillOpacity={0.08}
              isAnimationActive={false}
              legendType="none"
            />
            <Bar dataKey="confirmed" stackId="cash" fill="#22C55E" isAnimationActive={false} />
            <Bar dataKey="projected" stackId="cash" fill="#7B61FF" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex gap-4 font-mono text-xs text-text-secondary">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-success" /> confirmed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent" /> projected
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-accent/20" /> confidence band
        </span>
      </div>

      <ScrollX>
        <table className="mt-4 w-full min-w-[640px] border-collapse">
          <thead>
            <tr className="border-b border-border text-left">
              {['week', 'from', 'confirmed', 'projected', 'cumulative', 'band'].map((h) => (
                <th key={h} className="pb-2 font-mono text-xs font-normal text-text-secondary">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {f.weeks.map((w) => (
              <tr key={w.weekIndex} className="border-b border-border/50">
                <td className="tabular py-2 pr-4 font-mono text-xs text-text-primary">
                  {w.weekIndex}
                </td>
                <td className="tabular py-2 pr-4 font-mono text-xs text-text-secondary">
                  {w.weekStart}
                </td>
                <td className="tabular py-2 pr-4 font-mono text-xs text-success">
                  {w.confirmed !== '0.00' ? w.confirmed : '—'}
                </td>
                <td className="tabular py-2 pr-4 font-mono text-xs text-accent">
                  {w.projected !== '0.00' ? w.projected : '—'}
                </td>
                <td className="tabular py-2 pr-4 font-mono text-xs text-text-primary">
                  {w.cumulative}
                </td>
                <td className="tabular py-2 font-mono text-xs text-text-secondary">
                  {w.bandLow} – {w.bandHigh}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollX>
    </div>
  )
}
