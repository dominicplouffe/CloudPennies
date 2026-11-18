import { useEffect, useRef, useState } from 'react';
import type { Insight, InsightCategory } from '../../core/types';
import { money, pct } from '../../core/util';
import { CATEGORY, Empty, Icon, LevelBadge, PageHead } from '../bits';
import { Legend, Segments } from '../charts';
import { useStore } from '../store';

export function Savings() {
  const s = useStore();
  const r = s.report!;
  const [cat, setCat] = useState<InsightCategory | 'all' | 'quick'>('all');
  const [showDismissed, setShowDismissed] = useState(false);

  const active = r.insights.filter((i) => !s.dismissed.has(i.id));
  const hidden = r.insights.filter((i) => s.dismissed.has(i.id));
  const total = active.reduce((a, i) => a + i.monthlySavings, 0);
  const quick = active.filter((i) => i.effort === 'low' && i.monthlySavings > 0);
  const byCat = (Object.keys(CATEGORY) as InsightCategory[])
    .map((c) => ({ c, items: active.filter((i) => i.category === c), value: active.filter((i) => i.category === c).reduce((a, i) => a + i.monthlySavings, 0) }))
    .filter((x) => x.items.length)
    .sort((a, b) => b.value - a.value);
  const list = cat === 'all' ? active : cat === 'quick' ? quick : active.filter((i) => i.category === cat);

  // open the focused insight's category
  useEffect(() => {
    if (s.focusId) setCat('all');
  }, [s.focusId]);

  return (
    <>
      <PageHead
        eyebrow="Savings"
        title={
          <>
            Up to {money(total)} a month is on the table
          </>
        }
        sub={`That is ${pct((total / Math.max(1, r.briefing.last30)) * 100)} of what you spent in the last 30 days — ${money(total * 12, { compact: true })} a year. ${quick.length} of the ${active.length} opportunities are low-effort and worth ${money(quick.reduce((a, i) => a + i.monthlySavings, 0))}/month on their own.`}
      />

      {active.length > 0 && (
        <div className="card pad" style={{ marginTop: 22 }}>
          <Segments height={10} parts={byCat.map((x) => ({ label: CATEGORY[x.c].label, value: x.value, color: CATEGORY[x.c].color }))} />
          <div style={{ marginTop: 12 }}>
            <Legend items={byCat.filter((x) => x.value > 0).map((x) => ({ name: CATEGORY[x.c].label, color: CATEGORY[x.c].color, extra: <b className="num" style={{ color: 'var(--ink)', fontWeight: 600 }}>{money(x.value)}</b> }))} />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '18px 0 12px' }}>
        <FilterChip on={cat === 'all'} onClick={() => setCat('all')} label={`All (${active.length})`} />
        <FilterChip on={cat === 'quick'} onClick={() => setCat('quick')} label={`Quick wins (${quick.length})`} icon="bolt" />
        {byCat.map((x) => (
          <FilterChip key={x.c} on={cat === x.c} onClick={() => setCat(x.c)} label={`${CATEGORY[x.c].label} (${x.items.length})`} />
        ))}
      </div>

      {list.length === 0 ? (
        <Empty title="Nothing here">No open opportunities in this view.</Empty>
      ) : (
        <div className="card rows">
          {list.map((i) => (
            <InsightRow key={i.id} i={i} />
          ))}
        </div>
      )}

      {hidden.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button className="link" onClick={() => setShowDismissed(!showDismissed)}>
            {showDismissed ? 'Hide' : 'Show'} {hidden.length} dismissed
          </button>
          {showDismissed && (
            <div className="card rows" style={{ marginTop: 10, opacity: 0.75 }}>
              {hidden.map((i) => (
                <InsightRow key={i.id} i={i} />
              ))}
            </div>
          )}
        </div>
      )}

      <p className="muted" style={{ fontSize: 12, marginTop: 24, maxWidth: 720 }}>
        "Up to" because some savings overlap: rightsizing an instance lowers the commitment you need, for example. Figures marked "rough estimate" are inferred from billing data alone with stated assumptions; "firm number" figures come from exact prices or from AWS's own recommendation engines.
      </p>
    </>
  );
}

function FilterChip({ on, onClick, label, icon }: { on: boolean; onClick(): void; label: string; icon?: string }) {
  return (
    <button className="chip" onClick={onClick} style={{ paddingRight: 11, cursor: 'pointer', ...(on ? { background: 'var(--ink)', color: 'var(--page)', borderColor: 'var(--ink)' } : {}) }}>
      {icon && <Icon name={icon} size={13} />}
      {label}
    </button>
  );
}

export function InsightRow({ i, defaultOpen }: { i: Insight; defaultOpen?: boolean }) {
  const s = useStore();
  const focused = s.focusId === i.id;
  const [open, setOpen] = useState(!!defaultOpen || focused);
  const [allRes, setAllRes] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) {
      setOpen(true);
      ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [focused]);
  const dismissed = s.dismissed.has(i.id);
  const resources = i.resources ?? [];
  const shown = allRes ? resources : resources.slice(0, 6);

  return (
    <div ref={ref} className={open ? 'open' : ''} style={focused ? { boxShadow: 'inset 3px 0 0 var(--accent)' } : undefined}>
      <button className="rowbtn insight-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <div className="cat-ico" title={CATEGORY[i.category].label}>
          <Icon name={CATEGORY[i.category].icon} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="insight-title">
            {i.title}
            {i.urgent && (
              <span className="badge crit" style={{ marginLeft: 8, verticalAlign: 1 }}>
                Time-sensitive
              </span>
            )}
          </div>
          <div className="insight-sum">{i.summary}</div>
        </div>
        <div className="save">
          {i.monthlySavings > 0 ? (
            <>
              <b>{money(i.monthlySavings)}</b>
              <span>per month</span>
            </>
          ) : (
            <span>{i.category === 'commitments' ? 'Avoids an increase' : 'Visibility'}</span>
          )}
        </div>
        <span className="chev">
          <Icon name="chev" size={16} />
        </span>
      </button>
      {open && (
        <div className="insight-body fade">
          <div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
              <LevelBadge kind="confidence" level={i.confidence} />
              <LevelBadge kind="effort" level={i.effort} />
              <LevelBadge kind="risk" level={i.risk} />
              <span className="badge">Source: {i.source}</span>
            </div>
            <h4>The evidence</h4>
            <dl className="kv">
              {i.evidence.map((e) => (
                <div key={e.label} style={{ display: 'contents' }}>
                  <dt>{e.label}</dt>
                  <dd>{e.value}</dd>
                </div>
              ))}
            </dl>
            {resources.length > 0 && (
              <>
                <h4 style={{ marginTop: 18 }}>
                  {resources.length === 1 ? 'Resource' : `Resources (${resources.length}${i.resources && resources.length >= 25 ? '+' : ''})`}
                </h4>
                <table className="tbl" style={{ fontSize: 12.5 }}>
                  <tbody>
                    {shown.map((x) => (
                      <tr key={x.id + x.detail}>
                        <td style={{ paddingLeft: 0 }}>
                          <div style={{ fontWeight: 550, wordBreak: 'break-all', userSelect: 'text' }}>{x.id}</div>
                          <div className="muted">{x.detail}</div>
                        </td>
                        <td className="r" style={{ paddingRight: 0, whiteSpace: 'nowrap' }}>
                          {x.monthlySavings ? `${money(x.monthlySavings, { cents: x.monthlySavings < 100 })}/mo` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {resources.length > 6 && (
                  <button className="link" style={{ marginTop: 6, fontSize: 12.5 }} onClick={() => setAllRes(!allRes)}>
                    {allRes ? 'Show fewer' : `Show all ${resources.length}`}
                  </button>
                )}
              </>
            )}
          </div>
          <div>
            <h4>What to do</h4>
            <ol className="steps">
              {i.steps.map((st, k) => (
                <li key={k}>{renderStep(st)}</li>
              ))}
            </ol>
            <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
              {i.thread && (
                <button className="btn sm" onClick={() => s.pullThread(i.thread!)}>
                  Pull the thread <Icon name="arrow" size={13} />
                </button>
              )}
              <button className="btn sm ghost" onClick={() => s.toggleDismissed(i.id)}>
                <Icon name={dismissed ? 'undo' : 'x'} size={13} /> {dismissed ? 'Restore' : 'Dismiss'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** render `code` spans in steps */
function renderStep(text: string) {
  return text.split(/(`[^`]+`)/).map((part, i) => (part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part));
}
