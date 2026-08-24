'use client'

import {
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ScoreAtThreshold } from '@/lib/eval/score'

/**
 * The confidence/coverage curve — the visual proof behind the headline metric.
 *
 * Precision and auto-clear rate trade off as the threshold moves: pin nothing
 * and coverage hits 100% at whatever precision falls out; demand certainty and
 * precision hits 100% at near-zero coverage. The operating point (marked) is
 * the lowest threshold whose precision still clears the target — this chart is
 * what makes that choice legible rather than asserted.
 */
export function CalibrationChart({
  curve,
  precisionTarget,
  operatingThreshold,
}: {
  curve: ScoreAtThreshold[]
  precisionTarget: number
  operatingThreshold: number
}) {
  const data = [...curve]
    .sort((a, b) => a.threshold - b.threshold)
    .map((c) => ({
      threshold: c.threshold,
      precision: Math.round(c.precision * 1000) / 10,
      autoClear: Math.round(c.autoClearRate * 1000) / 10,
    }))

  const operatingPoint = data.reduce((closest, d) =>
    Math.abs(d.threshold - operatingThreshold) < Math.abs(closest.threshold - operatingThreshold)
      ? d
      : closest,
  )

  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
          <XAxis
            dataKey="threshold"
            type="number"
            domain={[0, 1]}
            tickFormatter={(v) => v.toFixed(1)}
            tick={{ fill: '#8A8A96', fontFamily: 'DM Mono', fontSize: 11 }}
            stroke="#2A2A2E"
            label={{
              value: 'confidence threshold',
              position: 'insideBottom',
              offset: -4,
              fill: '#8A8A96',
              fontFamily: 'DM Mono',
              fontSize: 11,
            }}
          />
          <YAxis
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            tick={{ fill: '#8A8A96', fontFamily: 'DM Mono', fontSize: 11 }}
            stroke="#2A2A2E"
            width={44}
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
              `${value.toFixed(1)}%`,
              name === 'precision' ? 'precision' : 'auto-clear',
            ]}
            labelFormatter={(v: number) => `threshold ${v.toFixed(2)}`}
          />
          <ReferenceLine
            y={precisionTarget * 100}
            stroke="#F59E0B"
            strokeDasharray="4 4"
            label={{
              value: `target ${(precisionTarget * 100).toFixed(1)}%`,
              fill: '#F59E0B',
              fontFamily: 'DM Mono',
              fontSize: 10,
              position: 'insideTopRight',
            }}
          />
          <Line
            type="monotone"
            dataKey="precision"
            stroke="#22C55E"
            strokeWidth={2}
            dot={false}
            name="precision"
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="autoClear"
            stroke="#7B61FF"
            strokeWidth={2}
            dot={false}
            name="autoClear"
            isAnimationActive={false}
          />
          <ReferenceDot
            x={operatingPoint.threshold}
            y={operatingPoint.precision}
            r={5}
            fill="#22C55E"
            stroke="#0D0D0F"
            strokeWidth={2}
            isFront
            ifOverflow="extendDomain"
          />
          <ReferenceDot
            x={operatingPoint.threshold}
            y={operatingPoint.autoClear}
            r={5}
            fill="#7B61FF"
            stroke="#0D0D0F"
            strokeWidth={2}
            isFront
            ifOverflow="extendDomain"
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="mt-2 flex gap-4 font-mono text-xs text-text-secondary">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-success" /> precision
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-accent" /> auto-clear
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 border-t border-dashed border-warning" /> target
        </span>
        <span className="ml-auto">● operating point</span>
      </div>
    </div>
  )
}
