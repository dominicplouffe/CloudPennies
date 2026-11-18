import { useMemo, useState } from 'react';
import { BASIS_LABEL, shortService } from '../../core/catalog';
import { reportMarkdown } from '../../core/exportReport';
import { addDays, addMonths, daysInMonth, diffDays, fmtDateLong, money, monthStart, pct, pctChange } from '../../core/util';
import { CATEGORY, Delta, Icon } from '../bits';
import { Meter, TimeChart } from '../charts';
import { saveTextFile, useStore } from '../store';

export function Briefing() {
  const s = useStore();
  const snap = s.snapshot!;
  const r = s.report!;
  const b = r.briefing;
  const [range, setRange] = useState<'90d' | '13m'>('90d');

  const active = r.insights.filter((i) => !s.dismissed.has(i.id));
  const savings = active.reduce((a, i) => a + i.monthlySavings, 0);
  const firsts = active.filter((i) => i.urgent).slice(0, 4);
  const doFirst = firsts.length >= 3 ? firsts : [...firsts, ...active.filter((i) => !i.urgent && i.effort === 'low' && i.monthlySavings > 0).slice(0, 3 - firsts.length)];
  const nextExp = r.commitments.expirations[0];
  const maxMove = Math.max(...[...b.drivers, ...b.decreases].map((d) => Math.abs(d.delta)), 1);

  const markers = useMemo(
    () =>
      r.anomalies
        .filter((a) => a.source === 'CloudPennies')
        .slice(0, 8)
        .map((a) => ({ date: a.start, label: a.title, onClick: () => s.go('anomalies', a.id) })),
    [r, s],
  );

  // month chart: add a projected ghost point for the current month
  const monthDates = b.monthlyTotals.map((m) => m.date);
  const monthVals = b.monthlyTotals.map((m) => (m.partial ? b.projected : m.cost));

  const focus = monthStart(snap.meta.dataThrough);
  const dayN = diffDays(snap.meta.dataThrough, focus) + 1;
  const dim = daysInMonth(focus);

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
        <div className="eyebrow">
          Briefing · {fmtDateLong(snap.meta.dataThrough)} · day {dayN} of {dim}
        </div>
        <button className="btn sm ghost" onClick={() => void saveTextFile(`cloudpennies-briefing-${snap.meta.dataThrough}.md`, reportMarkdown(snap, r))}>
          <Icon name="download" size={14} /> Export
        </button>
      </div>
      <h1 className="headline">{b.headline}</h1>
      <div className="story">
        {b.story.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </div>

      <div className="grid g4" style={{ marginTop: 30 }}>
        <button className="card tile" onClick={() => s.setPage('explore')}>
          <div className="label">{b.monthLabel} so far</div>
          <div className="value">{money(b.mtd)}</div>
          <div className="foot">
            <Delta cur={b.mtd} prev={b.prevMtd} /> vs same days of {b.prevMonthLabel}
          </div>
        </button>
        <div className="card tile">
          <div className="label">Projected month-end</div>
          <div className="value">{money(b.projected)}</div>
          <div className="foot">
            <Delta cur={b.projected} prev={b.prevMonthTotal} /> vs {b.prevMonthLabel} ({money(b.prevMonthTotal, { compact: true })})
          </div>
          <div className="foot muted" style={{ marginTop: 2 }} title={b.forecastRejected ? `AWS's forecast for the rest of the month (${money(b.forecastRejected.awsRemaining)}) was far from the recent daily run rate (${money(b.forecastRejected.runRateRemaining)}), so the run rate is used instead.` : undefined}>
            {money(b.mtd, { compact: true })} so far + {money(b.projectedRemaining, { compact: true })} {b.projectionSource === 'aws' ? 'AWS forecast' : 'at current daily rate'}
          </div>
        </div>
        <button className="card tile" onClick={() => s.setPage('savings')}>
          <div className="label">Savings on the table</div>
          <div className="value">
            {money(savings)}
            <small> /mo</small>
          </div>
          <div className="foot">
            {active.filter((i) => i.monthlySavings > 0).length} opportunities · {b.last30 > 0 ? pct((savings / b.last30) * 100) : '—'} of spend
          </div>
        </button>
        <button className="card tile" onClick={() => s.setPage('commitments')}>
          <div className="label">Commitment coverage</div>
          <div className="value">{pct(r.commitments.coveragePct)}</div>
          <div className="foot">
            {nextExp ? (
              <>
                <span className={`badge ${nextExp.daysLeft <= 30 ? 'crit' : nextExp.daysLeft <= 60 ? 'warn' : ''}`}>Next expiry in {nextExp.daysLeft} days</span>
              </>
            ) : (
              'No commitments expiring this year'
            )}
          </div>
        </button>
      </div>

      <div className="card pad" style={{ marginTop: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div>
            <b style={{ fontSize: 14.5 }}>{range === '90d' ? 'Daily spend, last 90 days' : 'Monthly spend'}</b>
            <div className="muted" style={{ fontSize: 12.5 }}>
              {range === '90d' ? `${markers.length ? 'Red dots mark where an anomaly began — click one to see why.' : 'No anomalies in this window.'}${b.monthlyCharges.length ? ` Excludes once-a-month charges (${b.monthlyCharges.map((m) => `${m.label} ${money(m.amount)}`).join(', ')}).` : ''}` : `${b.monthLabel} is shown as projected (dotted).`}
            </div>
          </div>
          <div className="seg">
            <button className={range === '90d' ? 'on' : ''} onClick={() => setRange('90d')}>
              90 days
            </button>
            <button className={range === '13m' ? 'on' : ''} onClick={() => setRange('13m')}>
              13 months
            </button>
          </div>
        </div>
        {range === '90d' ? (
          <TimeChart kind="area" dates={b.dailyTotals.map((d) => d.date)} series={[{ name: 'Daily spend', color: 'var(--accent)', values: b.dailyTotals.map((d) => d.cost) }]} markers={markers} height={230} />
        ) : (
          <TimeChart kind="area" monthly dates={monthDates} series={[{ name: 'Monthly spend', color: 'var(--accent)', values: monthVals }]} ghostFrom={monthDates.length - 1} height={230} />
        )}
      </div>

      <div className="section-h">
        <h2>What changed</h2>
        <p>
          {cap(b.compare.label)} vs {b.compare.prevLabel} · {money(b.compare.current - b.compare.previous, { sign: true })} net ({pct(pctChange(b.compare.current, b.compare.previous), 0, true)})
        </p>
      </div>
      {b.drivers.length + b.decreases.length === 0 ? (
        <div className="card pad ink2">Nothing moved by more than a rounding error. A quiet month.</div>
      ) : (
        <div className="card rows">
          {[...b.drivers, ...b.decreases].map((d) => (
            <button key={d.service} className="rowbtn" style={{ gridTemplateColumns: '210px 1fr 150px 18px' }} onClick={() => s.pullThread({ label: shortService(d.service), filters: { SERVICE: [d.service] }, groupBy: 'USAGE_TYPE' })}>
              <div>
                <b style={{ fontWeight: 600 }}>{shortService(d.service)}</b>
                <div className="muted num" style={{ fontSize: 12 }}>
                  {money(d.previous)} → {money(d.current)}
                </div>
              </div>
              <div className="ink2" style={{ fontSize: 13 }}>
                {d.why}
              </div>
              <div>
                <div className={`delta ${d.delta > 0 ? 'up' : 'down'}`} style={{ justifyContent: 'flex-end', width: '100%' }}>
                  {money(d.delta, { sign: true })}
                </div>
                <div className="bar-track" style={{ marginTop: 5, display: 'flex', justifyContent: d.delta > 0 ? 'flex-start' : 'flex-end' }}>
                  <div className="bar-fill" style={{ width: `${(Math.abs(d.delta) / maxMove) * 100}%`, background: d.delta > 0 ? 'var(--crit)' : 'var(--good)' }} />
                </div>
              </div>
              <span className="muted">
                <Icon name="chev" size={16} />
              </span>
            </button>
          ))}
        </div>
      )}

      {doFirst.length > 0 && (
        <>
          <div className="section-h">
            <h2>Do these first</h2>
            <button className="link" onClick={() => s.setPage('savings')}>
              All {active.length} opportunities <Icon name="arrow" size={14} />
            </button>
          </div>
          <div className="card rows">
            {doFirst.map((i) => (
              <button key={i.id} className="rowbtn insight-head" onClick={() => s.go(i.category === 'commitments' ? 'commitments' : 'savings', i.id)}>
                <div className="cat-ico">
                  <Icon name={CATEGORY[i.category].icon} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="insight-title">
                    {i.title} {i.urgent && <span className="badge crit" style={{ marginLeft: 6 }}>Time-sensitive</span>}
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
                    <span>Avoids an increase</span>
                  )}
                </div>
                <span className="muted">
                  <Icon name="chev" size={16} />
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      <div className="grid g2" style={{ marginTop: 40, alignItems: 'start' }}>
        <div>
          <div className="section-h" style={{ marginTop: 0 }}>
            <h2>Where the money goes</h2>
            <p>Last 30 days · {money(b.last30)}</p>
          </div>
          <div className="card rows">
            {b.topServices.slice(0, 7).map((t) => (
              <button key={t.service} className="rowbtn" style={{ gridTemplateColumns: '1fr 90px 64px', padding: '10px 18px' }} onClick={() => s.pullThread({ label: shortService(t.service), filters: { SERVICE: [t.service] }, groupBy: 'USAGE_TYPE' })}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 550 }}>
                    <span>{shortService(t.service)}</span>
                  </div>
                  <div className="bar-track" style={{ marginTop: 5 }}>
                    <div className="bar-fill" style={{ width: `${(t.cost / b.topServices[0].cost) * 100}%` }} />
                  </div>
                </div>
                <div className="num" style={{ textAlign: 'right', fontWeight: 600 }}>
                  {money(t.cost)}
                  <div className="muted" style={{ fontSize: 11.5, fontWeight: 400 }}>
                    {pct(t.share * 100)}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <Delta cur={t.cost} prev={t.prev} />
                </div>
              </button>
            ))}
            {b.topServices.length > 7 && (
              <button className="rowbtn" style={{ gridTemplateColumns: '1fr auto', padding: '10px 18px' }} onClick={() => s.setPage('explore')}>
                <span className="ink2">{b.topServices.length - 7} more services</span>
                <span className="num ink2">{money(b.topServices.slice(7).reduce((a, t) => a + t.cost, 0))}</span>
              </button>
            )}
          </div>
        </div>
        <div>
          <div className="section-h" style={{ marginTop: 0 }}>
            <h2>Budgets & notes</h2>
          </div>
          <div className="card pad" style={{ display: 'grid', gap: 18 }}>
            {r.budgets.length === 0 && <div className="ink2">No AWS Budgets are set up on this account. A single monthly budget with an email alert is the cheapest safety net there is.</div>}
            {r.budgets.slice(0, 4).map((bd) => {
              const proj = bd.forecast ?? bd.actual;
              const over = proj > bd.limit;
              return (
                <div key={bd.name}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <b style={{ fontWeight: 600 }}>{bd.name}</b>
                    <span className="num ink2">
                      {money(bd.actual)} of {money(bd.limit)}
                    </span>
                  </div>
                  <div style={{ margin: '6px 0 4px' }}>
                    <Meter value={bd.actual} max={bd.limit} tone={bd.actual > bd.limit ? 'crit' : over ? 'warn' : undefined} />
                  </div>
                  <div style={{ fontSize: 12.5 }} className={over ? '' : 'muted'}>
                    {bd.forecast !== undefined ? (
                      over ? (
                        <span className="badge warn">
                          <Icon name="alert" size={12} /> Forecast {money(proj)} — {money(proj - bd.limit)} over
                        </span>
                      ) : (
                        `Forecast ${money(proj)} — on track`
                      )
                    ) : (
                      `${bd.timeUnit.toLowerCase()} budget`
                    )}
                  </div>
                </div>
              );
            })}
            {(b.creditsThisMonth < -0.5 || r.tagCoverage) && <div style={{ height: 1, background: 'var(--line)' }} />}
            {b.creditsThisMonth < -0.5 && (
              <div className="ink2" style={{ fontSize: 13 }}>
                <b style={{ color: 'var(--ink)' }}>{money(-b.creditsThisMonth)} in credits</b> applied this month. All figures in CloudPennies exclude credits and refunds, so an expiring credit never hides or fakes a trend.
              </div>
            )}
            {r.tagCoverage && (
              <div className="ink2" style={{ fontSize: 13 }}>
                <b style={{ color: 'var(--ink)' }}>{pct(100 - r.tagCoverage.untaggedPct)} of spend is tagged</b> with "{r.tagCoverage.key}".{' '}
                <button className="link" onClick={() => s.pullThread({ label: 'By ' + r.tagCoverage!.key, filters: {}, groupBy: `TAG:${r.tagCoverage!.key}` })}>
                  See spend by {r.tagCoverage.key}
                </button>
              </div>
            )}
          </div>
          {snap.meta.warnings.length > 0 && (
            <div className="note warn" style={{ marginTop: 14 }}>
              <Icon name="info" size={16} />
              <span>
                {snap.meta.warnings.length} part{snap.meta.warnings.length === 1 ? '' : 's'} of the scan could not run, so some findings may be missing.{' '}
                <button className="link" onClick={() => s.setPage('settings')}>
                  See what and why
                </button>
              </span>
            </div>
          )}
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 36 }}>
        {snap.meta.mode === 'demo' ? 'Demo data for a fictional company.' : `Scanned ${new Date(snap.meta.generatedAt).toLocaleString()} · ${snap.meta.ceRequests} Cost Explorer requests (${money(snap.meta.ceRequests * 0.01, { cents: true })}).`} Costs are {BASIS_LABEL[snap.meta.costBasis] ?? 'unblended'}, before credits and refunds. Latest day may still be settling.
      </p>
    </>
  );
}

const cap = (x: string) => x[0].toUpperCase() + x.slice(1);
void addDays;
void addMonths;
