import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts'
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent'
import { formatMoney, monthLabel } from '../lib/money'
import type { CashFlowPoint, CategorySpend, NetWorthPoint } from '../lib/types'

// Chart chrome reads the same CSS tokens as the app, so light/dark swap in one place.
const AXIS_TICK = { fill: 'var(--ink-3)', fontSize: 12 }

function TooltipBox({ title, rows }: { title: string; rows: { label: string; value: string; color?: string }[] }) {
  return (
    <div className="min-w-40 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] shadow-pop">
      <div className="mb-1 font-medium text-ink">{title}</div>
      {rows.map((r) => (
        <div key={r.label} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-ink-2">
            {r.color && <span className="size-2 rounded-full" style={{ background: r.color }} />}
            {r.label}
          </span>
          <span className="tnum font-medium text-ink">{r.value}</span>
        </div>
      ))}
    </div>
  )
}

export function NetWorthChart({ data, currency }: { data: NetWorthPoint[]; currency: string }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="nw-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--series-1)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--series-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--grid)" />
        <XAxis
          dataKey="month"
          tickFormatter={(m) => monthLabel(m)}
          tick={AXIS_TICK}
          axisLine={{ stroke: 'var(--axis)' }}
          tickLine={false}
          tickMargin={8}
        />
        <YAxis
          tickFormatter={(v) => formatMoney(v, currency, { compact: true })}
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
          width={56}
          domain={['auto', 'auto']}
          className="tnum"
        />
        <Tooltip
          cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }}
          content={({ active, payload }: TooltipContentProps<ValueType, NameType>) =>
            active && payload?.length ? (
              <TooltipBox
                title={monthLabel(payload[0].payload.month, 'long')}
                rows={[{ label: 'Net worth (month end)', value: formatMoney(payload[0].payload.net_worth_minor, currency) }]}
              />
            ) : null
          }
        />
        <Area
          type="monotone"
          dataKey="net_worth_minor"
          stroke="var(--series-1)"
          strokeWidth={2}
          fill="url(#nw-fill)"
          dot={false}
          activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2, fill: 'var(--series-1)' }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function CashFlowChart({ data, currency }: { data: CashFlowPoint[]; currency: string }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-4 px-1 text-[13px] text-ink-2" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-[var(--series-1)]" /> Income
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-[3px] bg-[var(--series-2)]" /> Spending
        </span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis
            dataKey="month"
            tickFormatter={(m) => monthLabel(m)}
            tick={AXIS_TICK}
            axisLine={{ stroke: 'var(--axis)' }}
            tickLine={false}
            tickMargin={8}
          />
          <YAxis
            tickFormatter={(v) => formatMoney(v, currency, { compact: true })}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload }: TooltipContentProps<ValueType, NameType>) => {
              if (!active || !payload?.length) return null
              const p = payload[0].payload as CashFlowPoint
              return (
                <TooltipBox
                  title={monthLabel(p.month, 'long')}
                  rows={[
                    { label: 'Income', value: formatMoney(p.income_minor, currency), color: 'var(--series-1)' },
                    { label: 'Spending', value: formatMoney(p.expense_minor, currency), color: 'var(--series-2)' },
                    { label: 'Net', value: formatMoney(p.net_minor, currency, { signed: true }) },
                  ]}
                />
              )
            }}
          />
          <Bar dataKey="income_minor" name="Income" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
          <Bar dataKey="expense_minor" name="Spending" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Magnitude by category: a ranked bar list (one hue, direct labels) reads better than a donut. */
export function CategoryBars({ data, currency, limit = 7 }: { data: CategorySpend[]; currency: string; limit?: number }) {
  const positive = data.filter((d) => d.spent_minor > 0)
  const shown = positive.slice(0, limit)
  const rest = positive.slice(limit).reduce((s, d) => s + d.spent_minor, 0)
  const rows = rest > 0 ? [...shown, { account_id: 'other', account_name: 'Other', currency, spent_minor: rest }] : shown
  const total = positive.reduce((s, d) => s + d.spent_minor, 0)
  const max = Math.max(1, ...rows.map((r) => r.spent_minor))
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.account_id} className="group" title={`${r.account_name}: ${formatMoney(r.spent_minor, currency)}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="truncate text-ink">{r.account_name}</span>
            <span className="shrink-0">
              <span className="tnum font-medium">{formatMoney(r.spent_minor, currency)}</span>
              <span className="tnum ml-2 inline-block w-9 text-right text-ink-3">
                {Math.round((r.spent_minor / total) * 100)}%
              </span>
            </span>
          </div>
          <div className="h-2 rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-[var(--series-1)] transition-[width] duration-500 group-hover:brightness-110"
              style={{ width: `${Math.max(2, (r.spent_minor / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  )
}
