import { useEffect, useRef, useState } from 'react';
import { shortService } from '../../core/catalog';
import type { Anomaly } from '../../core/types';
import { diffDays, fmtDate, money } from '../../core/util';
import { Empty, Icon, PageHead } from '../bits';
import { Legend, Segments, SERIES_COLORS, TimeChart } from '../charts';
import { useStore } from '../store';

const SEV = { high: { label: 'High impact', cls: 'crit' }, medium: { label: 'Medium impact', cls: 'warn' }, low: { label: 'Low impact', cls: '' } } as const;
const KIND = { spike: 'Spike', shift: 'Step change', new: 'New spend' } as const;

export function Anomalies() {
  const s = useStore();
  const r = s.report!;
  const [filter, setFilter] = useState<'all' | 'ongoing'>('all');
  const list = r.anomalies.filter((a) => filter === 'all' || a.ongoing);
  const ongoing = r.anomalies.filter((a) => a.ongoing);
  const runRate = ongoing.reduce((a, x) => a + x.monthlyRunRate, 0);
  const total = r.anomalies.reduce((a, x) => a + x.impact, 0);

  return (
    <>
      <PageHead
        eyebrow="Anomalies"
        title={r.anomalies.length ? `${ongoing.length} still running, ${r.anomalies.length - ongoing.length} resolved` : 'Nothing unusual'}
        sub={
          r.anomalies.length
            ? `Over the last 90 days, unexpected spend added up to ${money(total)}. ${runRate > 0 ? `What is still running costs about ${money(runRate)} a month.` : ''}`
            : 'Every line item is tracking within its normal range.'
        }
        right={
          r.anomalies.length ? (
            <div className="seg">
              <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
                All
              </button>
              <button className={filter === 'ongoing' ? 'on' : ''} onClick={() => setFilter('ongoing')}>
                Still running
              </button>
            </div>
          ) : undefined
        }
      />
      <div style={{ display: 'grid', gap: 14, marginTop: 24 }}>
        {list.length === 0 ? (
          <Empty title={r.anomalies.length ? 'Nothing is running hot right now' : 'No anomalies in the last 90 days'}>
            CloudPennies compares every service and usage type against its own 28-day baseline, every day. When something breaks pattern — a spike, a silent step-up, a brand-new service — it shows up here with the line item responsible.
          </Empty>
        ) : (
          list.map((a) => <AnomalyCard key={a.id} a={a} />)
        )}
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 24, maxWidth: 720 }}>
        How this works: each usage type is compared with the median of its previous 28 days. A day counts as anomalous when it exceeds that baseline by more than its normal day-to-day variation, at least 25%, and the total impact passes your threshold ({money(s.settings.anomalyMinImpact)}, change it in Settings). Charges that recur monthly are ignored.
      </p>
    </>
  );
}

function AnomalyCard({ a }: { a: Anomaly }) {
  const s = useStore();
  const ref = useRef<HTMLDivElement>(null);
  const focused = s.focusId === a.id;
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focused]);
  const days = diffDays(a.end, a.start) + 1;
  const sev = SEV[a.severity];
  const causeTotal = a.causes.reduce((x, c) => x + Math.max(0, c.impact), 0);

  return (
    <div className="card" ref={ref} style={focused ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 3px var(--accent-wash)' } : undefined}>
      <div className="pad" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.05fr)', gap: 28 }}>
        <div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            {a.ongoing ? (
              <span className="badge crit">
                <span className="dot" style={{ background: 'var(--crit)' }} /> Still running
              </span>
            ) : (
              <span className="badge good">
                <Icon name="check" size={12} /> Resolved
              </span>
            )}
            <span className={`badge ${sev.cls}`}>{sev.label}</span>
            <span className="badge">{KIND[a.kind]}</span>
            {a.source === 'AWS' && <span className="badge">AWS Anomaly Detection</span>}
          </div>
          <h3 style={{ fontSize: 17, letterSpacing: '-0.01em', lineHeight: 1.3 }}>{a.title}</h3>
          <p className="ink2" style={{ marginTop: 6 }}>
            {a.summary}
          </p>
          <div style={{ display: 'flex', gap: 28, marginTop: 16 }}>
            <Stat label={a.kind === 'new' ? 'Spent so far' : 'Extra cost so far'} value={money(a.impact)} />
            {a.ongoing && a.monthlyRunRate > 0 && <Stat label="If it continues" value={`${money(a.monthlyRunRate)}/mo`} />}
            <Stat label={a.ongoing ? 'Started' : 'When'} value={a.ongoing || days === 1 ? fmtDate(a.start) : `${fmtDate(a.start)} – ${fmtDate(a.end)}`} sub={`${days} day${days === 1 ? '' : 's'}`} />
          </div>
          {a.causes.length > 1 && (
            <div style={{ marginTop: 18 }}>
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                What is behind it
              </div>
              <Segments parts={a.causes.slice(0, 5).map((c, i) => ({ label: c.label, value: Math.max(0, c.impact), color: SERIES_COLORS[i] }))} />
              <div style={{ marginTop: 8 }}>
                <Legend items={a.causes.slice(0, 5).map((c, i) => ({ name: c.label, color: SERIES_COLORS[i], extra: <b className="num" style={{ color: 'var(--ink)', fontWeight: 600 }}>{causeTotal > 0 ? `${Math.round((Math.max(0, c.impact) / causeTotal) * 100)}%` : ''}</b> }))} />
              </div>
            </div>
          )}
          <button className="btn sm" style={{ marginTop: 18 }} onClick={() => s.pullThread(a.causes.length === 1 ? { label: a.thread.label, filters: { ...a.thread.filters, USAGE_TYPE: [a.causes[0].key] }, groupBy: 'LINKED_ACCOUNT' } : a.thread)}>
            Pull the thread in {shortService(a.service)} <Icon name="arrow" size={13} />
          </button>
        </div>
        <div>
          {a.series.length > 1 ? (
            <>
              <TimeChart kind="area" dates={a.series.map((p) => p.date)} series={[{ name: 'Actual', color: 'var(--accent)', values: a.series.map((p) => p.cost) }]} reference={a.kind === 'new' ? undefined : { name: 'Expected', values: a.series.map((p) => p.expected) }} band={[a.start < a.series[0].date ? a.series[0].date : a.start, a.end]} height={210} />
              <Legend
                items={[
                  { name: 'Actual daily cost', color: 'var(--accent)' },
                  ...(a.kind === 'new' ? [] : [{ name: 'Expected', color: 'var(--muted)' }]),
                  { name: 'Anomaly window', color: 'var(--crit-wash)' },
                ]}
              />
            </>
          ) : (
            <div className="note" style={{ height: '100%', alignItems: 'center' }}>
              <Icon name="info" size={16} />
              Reported by AWS Cost Anomaly Detection. Pull the thread to see the daily pattern.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div className="num" style={{ fontSize: 19, fontWeight: 630, letterSpacing: '-0.02em' }}>
        {value}
      </div>
      {sub && (
        <div className="muted" style={{ fontSize: 11.5 }}>
          {sub}
        </div>
      )}
    </div>
  );
}
