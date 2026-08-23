'use client'

/**
 * Adapted from DECLUTTR's ClutterScoreRing — same SVG construction and
 * stroke-dashoffset transition, rethresholded for auto-clear rate.
 */

const BAND = { danger: '#FF4D4D', warning: '#F59E0B', success: '#22C55E' }

function bandFor(pct: number): string {
  if (pct < 50) return BAND.danger
  if (pct < 75) return BAND.warning
  return BAND.success
}

type Props = {
  /** 0-100. */
  value: number
  size?: number
  /** Drawn as a faint arc behind the value — the honest ceiling. */
  ceiling?: number
  label?: string
}

export function ScoreRing({ value, size = 160, ceiling, label }: Props) {
  const radius = (size - 20) / 2
  const circumference = 2 * Math.PI * radius
  const pct = Math.max(0, Math.min(100, value))
  const color = bandFor(pct)

  return (
    <div className="flex flex-col items-center gap-2">
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#2A2A2E"
          strokeWidth={12}
        />
        {ceiling !== undefined && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#3A3A42"
            strokeWidth={12}
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - Math.min(100, ceiling) / 100)}
            strokeLinecap="round"
          />
        )}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={12}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.8s ease' }}
        />
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          style={{
            transform: 'rotate(90deg)',
            transformOrigin: '50% 50%',
            fill: color,
            fontSize: size * 0.2,
            fontFamily: 'DM Mono, monospace',
            fontWeight: 500,
          }}
        >
          {pct.toFixed(1)}%
        </text>
      </svg>
      {label && <p className="font-mono text-xs text-text-secondary">{label}</p>}
    </div>
  )
}
