import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowLeftRight, CheckCircle2, Copy, Download, FileSpreadsheet, Trash2, UploadCloud, Wand2 } from 'lucide-react'
import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react'
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Input, PageHeader, Select, Skeleton, useToast } from '../components/ui'
import { api } from '../lib/api'
import { isBalanceAccount, useAccounts } from '../lib/hooks'
import type { ImportBatch } from '../lib/types'

const DATE_FORMATS = [
  { value: '%Y-%m-%d', label: '2026-01-31' },
  { value: '%m/%d/%Y', label: '01/31/2026' },
  { value: '%d/%m/%Y', label: '31/01/2026' },
  { value: '%m/%d/%y', label: '01/31/26' },
  { value: '%d.%m.%Y', label: '31.01.2026' },
]

/** Minimal CSV splitter for the preview only; the server does the authoritative parse. */
function parseLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (c === '"') quoted = false
      else cur += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function guessDateFormat(sample: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(sample)) return '%Y-%m-%d'
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(sample)) return '%d.%m.%Y'
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(sample)
  if (m) {
    if (m[3].length === 2) return '%m/%d/%y'
    return Number(m[1]) > 12 ? '%d/%m/%Y' : '%m/%d/%Y'
  }
  return '%Y-%m-%d'
}

const SAMPLE = `Date,Description,Amount
${sampleRows()}`

function sampleRows(): string {
  const d = new Date()
  const iso = (offset: number) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset)
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  }
  return [
    `${iso(6)},WHOLE FOODS MARKET #1042,-92.17`,
    `${iso(5)},Blue Bottle Coffee,-5.25`,
    `${iso(5)},Blue Bottle Coffee,-5.25`,
    `${iso(4)},NETFLIX.COM,-15.49`,
    `${iso(3)},Venmo cashout,"1,200.00"`,
    `${iso(2)},Shell Oil 5543,-48.10`,
    `${iso(1)},Trader Joe's,-63.40`,
  ].join('\n')
}

export default function Import() {
  const { accounts, byId } = useAccounts()
  const qc = useQueryClient()
  const toast = useToast()
  const fileInput = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<string[][]>([])
  const [account, setAccount] = useState('')
  const [dateCol, setDateCol] = useState('date')
  const [descCol, setDescCol] = useState('description')
  const [amountCol, setAmountCol] = useState('amount')
  const [dateFormat, setDateFormat] = useState('%Y-%m-%d')
  const [invert, setInvert] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [result, setResult] = useState<ImportBatch | null>(null)

  const moneyAccounts = accounts.filter((a) => isBalanceAccount(a) && !a.is_archived)
  const selected = account || moneyAccounts[0]?.id || ''
  const headers = rows[0] ?? []

  const load = async (f: File) => {
    setFile(f)
    setResult(null)
    const text = await f.text()
    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    const parsed = lines.slice(0, 7).map(parseLine)
    setRows(parsed)
    const hdr = parsed[0] ?? []
    const find = (...names: string[]) =>
      hdr.find((h) => names.some((n) => h.toLowerCase().includes(n))) ?? hdr[0] ?? ''
    const d = find('date', 'posted')
    setDateCol(d)
    setDescCol(find('description', 'payee', 'merchant', 'memo', 'name'))
    setAmountCol(find('amount', 'value', 'debit'))
    const di = hdr.indexOf(d)
    if (parsed[1] && di >= 0) setDateFormat(guessDateFormat(parsed[1][di]))
  }

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData()
      form.append('file', file!)
      form.append('account_id', selected)
      form.append('date_column', dateCol)
      form.append('description_column', descCol)
      form.append('amount_column', amountCol)
      form.append('date_format', dateFormat)
      form.append('invert_amounts', String(invert))
      return api.uploadStatement(form)
    },
    onSuccess: (r) => {
      setResult(r)
      qc.invalidateQueries()
      toast(`Imported ${r.imported_count} new transaction${r.imported_count === 1 ? '' : 's'}`)
    },
  })

  const rowErrors = useMemo(() => {
    const body = upload.error && (upload.error as { body?: { errors?: string[] } }).body
    return body?.errors ?? []
  }, [upload.error])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (file && selected) upload.mutate()
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) load(f)
  }

  const useSample = () => load(new File([SAMPLE], 'sample-statement.csv', { type: 'text/csv' }))

  return (
    <div className="animate-in">
      <PageHeader
        title="Import a statement"
        description="Upload a CSV export from your bank. Overlapping statements are safe (rows are fingerprinted), and transfers between your own accounts are matched so they never count twice."
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="p-5">
          <form onSubmit={submit} className="space-y-5">
            <div
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInput.current?.click()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInput.current?.click()}
              role="button"
              tabIndex={0}
              className={clsx(
                'flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition',
                dragging ? 'border-brand bg-brand-soft' : 'border-line-strong hover:border-brand hover:bg-surface-hover',
              )}
            >
              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && load(e.target.files[0])}
              />
              {file ? (
                <>
                  <FileSpreadsheet className="mb-2 size-8 text-brand" />
                  <div className="font-medium">{file.name}</div>
                  <div className="text-sm text-ink-3">{(file.size / 1024).toFixed(1)} KB · click to choose another</div>
                </>
              ) : (
                <>
                  <UploadCloud className="mb-2 size-8 text-ink-3" />
                  <div className="font-medium">Drop a CSV here or click to browse</div>
                  <div className="text-sm text-ink-3">Up to 5 MB</div>
                </>
              )}
            </div>
            {!file && (
              <div className="flex flex-wrap items-center justify-center gap-2 text-sm">
                <Button type="button" size="sm" variant="secondary" icon={<Wand2 className="size-3.5" />} onClick={useSample}>
                  Use a sample statement
                </Button>
                <a
                  href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE)}`}
                  download="sample-statement.csv"
                  className="inline-flex items-center gap-1 px-2 text-ink-2 hover:text-ink"
                >
                  <Download className="size-3.5" /> Download sample
                </a>
              </div>
            )}

            {rows.length > 1 && (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-[13px]">
                  <thead className="bg-surface-2 text-left text-ink-2">
                    <tr>
                      {headers.map((h, i) => (
                        <th key={i} className="px-3 py-2 font-medium whitespace-nowrap">
                          {h}
                          {h === dateCol && <Badge tone="brand" className="ml-1.5">date</Badge>}
                          {h === descCol && <Badge tone="brand" className="ml-1.5">description</Badge>}
                          {h === amountCol && <Badge tone="brand" className="ml-1.5">amount</Badge>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="tnum">
                    {rows.slice(1).map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        {headers.map((_, j) => (
                          <td key={j} className="px-3 py-1.5 whitespace-nowrap text-ink-2">
                            {r[j]}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Import into">
                <Select value={selected} onChange={(e) => setAccount(e.target.value)}>
                  {moneyAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Date format">
                <Select value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}>
                  {DATE_FORMATS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {(['date', 'description', 'amount'] as const).map((kind) => {
                const [value, set] =
                  kind === 'date' ? [dateCol, setDateCol] : kind === 'description' ? [descCol, setDescCol] : [amountCol, setAmountCol]
                return (
                  <Field key={kind} label={`${kind[0].toUpperCase()}${kind.slice(1)} column`}>
                    {headers.length ? (
                      <Select value={value} onChange={(e) => set(e.target.value)}>
                        {headers.map((h) => (
                          <option key={h}>{h}</option>
                        ))}
                      </Select>
                    ) : (
                      <Input value={value} onChange={(e) => set(e.target.value)} />
                    )}
                  </Field>
                )
              })}
              <label className="flex items-start gap-2.5 self-end pb-2 text-sm">
                <input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} className="mt-0.5 size-4 accent-[var(--brand)]" />
                <span>
                  Purchases are positive
                  <span className="block text-xs text-ink-3">Common in credit card exports</span>
                </span>
              </label>
            </div>

            {upload.error && (
              <div className="space-y-2">
                <ErrorNote error={upload.error} />
                {rowErrors.length > 0 && (
                  <ul className="max-h-40 overflow-y-auto rounded-lg border border-line p-3 text-xs text-ink-2">
                    {rowErrors.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
                <p className="text-xs text-ink-3">Imports are atomic: nothing was saved.</p>
              </div>
            )}

            {result && (
              <div className="animate-in grid grid-cols-2 gap-3 rounded-xl border border-line bg-good-soft p-4 sm:grid-cols-4">
                <div className="col-span-2 mb-1 flex items-center gap-2 text-sm font-medium text-good-ink sm:col-span-4">
                  <CheckCircle2 className="size-4" /> Import complete
                </div>
                <ResultStat label="New" value={result.imported_count} />
                <ResultStat label="Matched as transfers" value={result.transfer_count} />
                <ResultStat label="Already imported" value={result.duplicate_count} />
                <ResultStat label="Skipped (zero)" value={result.skipped_count} />
                {result.transfer_count > 0 && (
                  <p className="col-span-2 text-xs text-ink-2 sm:col-span-4">
                    These rows mirrored an earlier import from another of your accounts, so each pair was merged into a
                    single transfer instead of counting as both income and spending.
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <Button type="submit" size="lg" disabled={!file || !selected} loading={upload.isPending} icon={<UploadCloud className="size-4" />}>
                Import statement
              </Button>
            </div>
          </form>
        </Card>

        <div className="space-y-4">
          <Rules />
          <History byId={byId} />
        </div>
      </div>
    </div>
  )
}

function ResultStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="tnum text-2xl font-semibold">{value}</div>
      <div className="text-xs text-ink-2">{label}</div>
    </div>
  )
}

function History({ byId }: { byId: Map<string, { name: string }> }) {
  const q = useQuery({ queryKey: ['imports'], queryFn: api.imports })
  return (
    <Card>
      <CardHeader title="Import history" />
      {q.isPending ? (
        <div className="space-y-2 px-5 pb-5">
          <Skeleton className="h-10" />
        </div>
      ) : q.data?.length ? (
        <ul className="divide-y divide-line">
          {q.data.slice(0, 8).map((b) => (
            <li key={b.id} className="px-5 py-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{b.filename}</span>
                <span className="shrink-0 text-xs text-ink-3">{new Date(b.created_at).toLocaleDateString()}</span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-ink-3">
                <span>{byId.get(b.account_id)?.name}</span>
                <span className="tnum">{b.imported_count} new</span>
                {b.transfer_count > 0 && (
                  <span className="tnum inline-flex items-center gap-1">
                    <ArrowLeftRight className="size-3" />
                    {b.transfer_count} transfers matched
                  </span>
                )}
                {b.duplicate_count > 0 && (
                  <span className="tnum inline-flex items-center gap-1">
                    <Copy className="size-3" />
                    {b.duplicate_count} duplicates skipped
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 pb-5 text-sm text-ink-3">No imports yet.</p>
      )}
    </Card>
  )
}

function Rules() {
  const { accounts, byId } = useAccounts()
  const qc = useQueryClient()
  const rules = useQuery({ queryKey: ['rules'], queryFn: api.rules })
  const [pattern, setPattern] = useState('')
  const [target, setTarget] = useState('')
  const categories = accounts.filter((a) => (a.type === 'expense' || a.type === 'income') && !a.is_archived)
  const chosen = target || categories.find((c) => c.type === 'expense')?.id || ''

  const add = useMutation({
    mutationFn: () => api.createRule({ pattern: pattern.trim(), account_id: chosen }),
    onSuccess: () => {
      setPattern('')
      qc.invalidateQueries({ queryKey: ['rules'] })
    },
  })
  const del = useMutation({
    mutationFn: api.deleteRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  })

  return (
    <Card>
      <CardHeader title="Categorization rules" subtitle="Imported rows whose description contains the text get this category." />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (pattern.trim()) add.mutate()
        }}
        className="grid grid-cols-[1fr_auto] gap-2 px-5 pb-3"
      >
        <Input
          placeholder="Description contains… e.g. netflix"
          value={pattern}
          onChange={(e) => setPattern(e.target.value)}
          aria-label="Pattern"
          className="col-span-2"
        />
        <Select value={chosen} onChange={(e) => setTarget(e.target.value)} className="min-w-0" aria-label="Category">
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" loading={add.isPending} disabled={!pattern.trim()}>
          Add
        </Button>
      </form>
      {add.error && (
        <div className="px-5 pb-3">
          <ErrorNote error={add.error} />
        </div>
      )}
      <ul className="max-h-64 overflow-y-auto px-2 pb-2">
        {(rules.data ?? []).map((r) => (
          <li key={r.id} className="group flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm hover:bg-surface-hover">
            <code className="truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{r.pattern}</code>
            <span className="text-ink-3">→</span>
            <span className="flex-1 truncate">{byId.get(r.account_id)?.name}</span>
            <button
              onClick={() => del.mutate(r.id)}
              className="rounded p-1 text-ink-3 hover:text-critical-ink sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
              aria-label={`Delete rule ${r.pattern}`}
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
        {rules.data?.length === 0 && <li className="px-3 pb-3 text-sm text-ink-3">No rules yet.</li>}
      </ul>
    </Card>
  )
}
