import { useEffect, useMemo, useState } from 'react';
import { REGION_NAMES, describeUsage, dimLabel, shortService, stripRegion } from '../../core/catalog';
import type { CostRow, Dim } from '../../core/types';
import { addDays, addMonths, dateRange, daysInMonth, diffDays, money, monthStart, pct } from '../../core/util';
import { Delta, Icon, PageHead } from '../bits';
import { Legend, OTHER_COLOR, SERIES_COLORS, Spark, TimeChart } from '../charts';
import { saveTextFile, useStore, type Period } from '../store';

const PERIODS: { id: Period; label: string }[] = [
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'mtd', label: 'This month' },
  { id: 'last-month', label: 'Last month' },
  { id: '12m', label: '12 months' },
];

function periodRange(p: Period, today: string) {
  const ms = monthStart(today);
  switch (p) {
    case '30d':
      return { start: addDays(today, -30), end: today, prevStart: addDays(today, -60), monthly: false };
    case '90d':
      return { start: addDays(today, -90), end: today, prevStart: addDays(today, -180), monthly: false };
    case 'mtd': {
      const start = today === ms ? addMonths(ms, -1) : ms;
      const end = today === ms ? ms : today;
      return { start, end, prevStart: addMonths(start, -1), prevEnd: addDays(addMonths(start, -1), Math.min(diffDays(end, start), daysInMonth(addMonths(start, -1)))), monthly: false };
    }
    case 'last-month':
      return { start: addMonths(ms, -1), end: ms, prevStart: addMonths(ms, -2), monthly: false };
    case '12m':
      return { start: addMonths(ms, -12), end: today, prevStart: null, monthly: true };
  }
}

interface Row {
  key: string;
  label: string;
  sub?: string;
  cost: number;
  prev: number;
  values: number[];
}

export function Explore() {
  const s = useStore();
  const snap = s.snapshot!;
  const { filters, groupBy, period } = s.explore;
  const today = snap.meta.today;
  const range = useMemo(() => periodRange(period, today), [period, today]);
  const [rows, setRows] = useState<CostRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError(null);
    s.source
      .query({ start: range.prevStart ?? range.start, end: range.end, granularity: range.monthly ? 'MONTHLY' : 'DAILY', groupBy: [groupBy], filters })
      .then((res) => {
        if (dead) return;
        setRows(res.rows);
        setLoading(false);
      })
      .catch((e) => {
        if (dead) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.source, range, groupBy, filterKey]);

  const dates = useMemo(() => {
    if (range.monthly) {
      const out: string[] = [];
      for (let d = range.start; d < range.end; d = addMonths(d, 1)) out.push(d);
      return out;
    }
    return dateRange(range.start, range.end);
  }, [range]);

  const accountName = (id: string) => snap.accounts.find((a) => a.id === id)?.name;
  const singleService = filters.SERVICE?.length === 1 ? filters.SERVICE[0] : '';

  const labelFor = (key: string): { label: string; sub?: string } => {
    if (groupBy === 'SERVICE') return { label: shortService(key), sub: shortService(key) === key ? undefined : key };
    if (groupBy === 'USAGE_TYPE') {
      const label = describeUsage(singleService, key);
      const m = key.match(/^([A-Z]{2,4}\d?)-/);
      return { label: label === stripRegion(key) ? key : label, sub: label === stripRegion(key) ? undefined : key + (m ? '' : '') };
    }
    if (groupBy === 'LINKED_ACCOUNT') return { label: accountName(key) ?? key, sub: accountName(key) ? key : undefined };
    if (groupBy === 'REGION') return { label: REGION_NAMES[key] ?? (key || 'No region'), sub: REGION_NAMES[key] ? key : undefined };
    if (groupBy.startsWith('TAG:')) return { label: key || '(untagged)' };
    return { label: key || '(none)' };
  };

  const table = useMemo<Row[]>(() => {
    if (!rows) return [];
    const idx = new Map(dates.map((d, i) => [d, i]));
    const prevEnd = (range as { prevEnd?: string }).prevEnd ?? range.start;
    const m = new Map<string, Row>();
    for (const r of rows) {
      const key = r.keys[0] ?? '';
      let row = m.get(key);
      if (!row) m.set(key, (row = { key, ...labelFor(key), cost: 0, prev: 0, values: new Array(dates.length).fill(0) }));
      const i = idx.get(r.date);
      if (i !== undefined) {
        row.cost += r.cost;
        row.values[i] += r.cost;
      } else if (r.date < prevEnd) row.prev += r.cost;
    }
    return [...m.values()].filter((r) => Math.abs(r.cost) > 0.005 || Math.abs(r.prev) > 0.005).sort((a, b) => b.cost - a.cost);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, dates, range, groupBy, singleService]);

  const total = table.reduce((a, r) => a + r.cost, 0);
  const prevTotal = table.reduce((a, r) => a + r.prev, 0);
  const hasPrev = range.prevStart !== null;

  const top = table.slice(0, 7);
  const rest = table.slice(7);
  const series = [
    ...top.map((r, i) => ({ name: r.label, color: SERIES_COLORS[i], values: r.values })),
    ...(rest.length ? [{ name: `${rest.length} others`, color: OTHER_COLOR, values: dates.map((_, i) => rest.reduce((a, r) => a + r.values[i], 0)) }] : []),
  ];
  const colorOf = (key: string) => {
    const i = top.findIndex((r) => r.key === key);
    return i >= 0 ? SERIES_COLORS[i] : OTHER_COLOR;
  };

  const DIMS: Dim[] = ['SERVICE', 'USAGE_TYPE', 'LINKED_ACCOUNT', 'REGION', ...snap.tagKeys.slice(0, 2).map((k) => `TAG:${k}` as Dim), 'PURCHASE_TYPE'];
  const drill = (key: string) => {
    const nextFilters = { ...filters, [groupBy]: [key] };
    const order: Dim[] = ['SERVICE', 'USAGE_TYPE', 'LINKED_ACCOUNT', 'REGION', ...snap.tagKeys.slice(0, 1).map((k) => `TAG:${k}` as Dim)];
    const next = order.find((d) => !(d in nextFilters)) ?? groupBy;
    s.setExplore({ ...s.explore, filters: nextFilters, groupBy: next });
    setShowAll(false);
  };
  const removeFilter = (d: Dim) => {
    const next = { ...filters };
    delete next[d];
    s.setExplore({ ...s.explore, filters: next });
  };
  const chipValue = (d: Dim, vals: string[]) => {
    if (vals.length > 1) return `${vals.length} selected`;
    const v = vals[0];
    if (d === 'SERVICE') return shortService(v);
    if (d === 'USAGE_TYPE') return describeUsage(singleService, v);
    if (d === 'LINKED_ACCOUNT') return accountName(v) ?? v;
    return v || '(untagged)';
  };

  const exportCsv = () => {
    const head = [dimLabel(groupBy), 'Key', 'Cost', ...(hasPrev ? ['Previous period'] : []), ...dates];
    const esc = (x: string) => `"${x.replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(','), ...table.map((r) => [esc(r.label), esc(r.key), r.cost.toFixed(2), ...(hasPrev ? [r.prev.toFixed(2)] : []), ...r.values.map((v) => v.toFixed(2))].join(','))];
    void saveTextFile(`cloudpennies-${groupBy.toLowerCase().replace(':', '-')}-${today}.csv`, lines.join('\n'));
  };

  const filterDims = Object.keys(filters) as Dim[];
  const visible = showAll ? table : table.slice(0, 25);

  return (
    <>
      <PageHead
        eyebrow="Explore"
        title="Pull on any thread"
        sub="Click a row to drill into it. Each click narrows the view and shows the next level down — service, line item, account, region."
        right={
          <button className="btn sm ghost" onClick={exportCsv} disabled={!table.length}>
            <Icon name="download" size={14} /> CSV
          </button>
        }
      />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', margin: '22px 0 12px' }}>
        <div className="seg">
          {PERIODS.map((p) => (
            <button key={p.id} className={period === p.id ? 'on' : ''} onClick={() => s.setExplore({ ...s.explore, period: p.id })}>
              {p.label}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>
          split by
        </span>
        <div className="seg">
          {DIMS.map((d) => (
            <button key={d} className={groupBy === d ? 'on' : ''} onClick={() => s.setExplore({ ...s.explore, groupBy: d })}>
              {dimLabel(d).replace('Tag: ', '')}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minHeight: 30, marginBottom: 14 }}>
        <button className={`chip`} style={{ paddingRight: 11, cursor: filterDims.length ? 'pointer' : 'default', background: filterDims.length ? undefined : 'var(--surface-2)' }} onClick={() => s.setExplore({ ...s.explore, filters: {}, groupBy: 'SERVICE' })}>
          All spend
        </button>
        {filterDims.map((d) => (
          <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className="muted">
              <Icon name="chev" size={14} />
            </span>
            <span className="chip">
              <i>{dimLabel(d)}</i> {chipValue(d, filters[d]!)}
              <button aria-label={`Remove ${dimLabel(d)} filter`} onClick={() => removeFilter(d)}>
                <Icon name="x" size={12} />
              </button>
            </span>
          </span>
        ))}
      </div>

      <div className="card pad" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 30, fontWeight: 620, letterSpacing: '-0.025em' }}>{money(total)}</span>
          {hasPrev && (
            <span className="ink2">
              <Delta cur={total} prev={prevTotal} /> vs previous period ({money(prevTotal)})
            </span>
          )}
        </div>
        {error ? (
          <div className="note err">
            <Icon name="alert" size={16} />
            {error}
          </div>
        ) : (
          <>
            <TimeChart kind="stack" dates={dates} series={series} monthly={range.monthly} height={250} />
            <div style={{ marginTop: 12 }}>
              <Legend items={series.map((x) => ({ name: x.name, color: x.color }))} />
            </div>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 14, overflow: 'hidden', opacity: loading ? 0.6 : 1 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ paddingLeft: 22 }}>{dimLabel(groupBy)}</th>
              <th style={{ width: 150 }}>Share</th>
              <th className="r">Cost</th>
              {hasPrev && <th className="r">Change</th>}
              <th style={{ width: 110 }}>Trend</th>
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.key} className="click" onClick={() => drill(r.key)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && drill(r.key)}>
                <td style={{ paddingLeft: 22 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span className="dot" style={{ background: colorOf(r.key) }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 550 }}>{r.label}</div>
                      {r.sub && <div className="sub">{r.sub}</div>}
                    </div>
                  </div>
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div className="bar-track" style={{ flex: 1 }}>
                      <div className="bar-fill" style={{ width: `${total > 0 ? Math.max(0, (r.cost / (table[0]?.cost || 1)) * 100) : 0}%`, background: 'var(--ink-2)' }} />
                    </div>
                    <span className="num muted" style={{ fontSize: 12, width: 34, textAlign: 'right' }}>
                      {total > 0 ? (r.cost / total > 0 && r.cost / total < 0.005 ? '<1%' : pct((r.cost / total) * 100)) : '—'}
                    </span>
                  </div>
                </td>
                <td className="r" style={{ fontWeight: 600 }}>
                  {money(r.cost)}
                </td>
                {hasPrev && (
                  <td className="r">
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                      <Delta cur={r.cost} prev={r.prev} />
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        {Math.abs(r.cost - r.prev) >= 0.5 ? money(r.cost - r.prev, { sign: true }) : ''}
                      </span>
                    </div>
                  </td>
                )}
                <td>
                  <Spark values={r.values} />
                </td>
                <td className="muted">
                  <Icon name="chev" size={15} />
                </td>
              </tr>
            ))}
            {!loading && !table.length && (
              <tr>
                <td colSpan={6} style={{ padding: 28, textAlign: 'center' }} className="muted">
                  No spend matches this view.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {table.length > 25 && !showAll && (
          <button className="rowbtn" style={{ gridTemplateColumns: '1fr', textAlign: 'center', borderTop: '1px solid var(--line)' }} onClick={() => setShowAll(true)}>
            <span className="link" style={{ justifyContent: 'center' }}>
              Show all {table.length} rows
            </span>
          </button>
        )}
      </div>
    </>
  );
}
