import { shortService } from '../../core/catalog';
import { addMonths, fmtDateLong, money, monthShort, monthStart, pct, diffDays } from '../../core/util';
import { Empty, Icon, PageHead } from '../bits';
import { Legend, TimeChart } from '../charts';
import { useStore } from '../store';
import { Planner } from './Planner';
import { InsightRow } from './Savings';

export function Commitments() {
  const s = useStore();
  const snap = s.snapshot!;
  const r = s.report!;
  const c = r.commitments;
  const raw = snap.commitments;
  const today = snap.meta.today;

  const buy = r.insights.filter((i) => i.category === 'commitments' && /^(sp-buy|ri-buy)/.test(i.id) && !s.dismissed.has(i.id));
  const buyTotal = buy.reduce((a, i) => a + i.monthlySavings, 0);
  const unused = r.insights.filter((i) => i.id.startsWith('unused-') && !s.dismissed.has(i.id));
  const hasAny = raw.savingsPlans.length + raw.reservations.length > 0;
  const soon = c.expirations.filter((e) => e.daysLeft <= 90);
  const exposure = soon.reduce((a, e) => a + e.monthlyExposure, 0);

  const title = soon.length
    ? `${soon.length} commitment${soon.length === 1 ? '' : 's'} expire${soon.length === 1 ? 's' : ''} in the next 90 days`
    : buyTotal > 0
      ? `${money(buyTotal)} a month in discounts you are not using yet`
      : hasAny
        ? 'Commitments are in good shape'
        : 'No commitments yet';

  // timeline: next 12 months
  const months = Array.from({ length: 13 }, (_, i) => addMonths(monthStart(today), i));
  const span = 365;
  const pos = (iso: string) => Math.min(100, Math.max(0, (diffDays(iso, today) / span) * 100));

  return (
    <>
      <PageHead
        eyebrow="Commitments"
        title={title}
        sub={
          soon.length
            ? `When they lapse, about ${money(exposure)}/month of discounts disappear and the same usage is billed at on-demand rates. Savings Plans and reservations never renew themselves.`
            : 'Savings Plans and Reserved Instances trade a spending promise for a lower rate. This page shows what you hold, what it saves, what to buy, and what is about to run out.'
        }
      />

      <div className="grid g4" style={{ marginTop: 24 }}>
        <Kpi label="Effective savings rate" value={pct(c.esrPct, 1)} foot={`${money(c.monthlyNetSavings)} saved in 30 days vs on-demand`} hint="Savings from commitments ÷ what eligible usage would cost at on-demand rates. Well-optimized accounts reach 25–40%." />
        <Kpi label="Coverage" value={pct(c.coveragePct)} foot={`${money(c.monthlyOnDemandEligible)}/mo still on-demand`} hint="Share of commitment-eligible usage that is covered by a Savings Plan or reservation." tone={c.coveragePct < 50 ? 'warn' : undefined} />
        <Kpi label="Utilization" value={hasAny ? pct(c.utilizationPct) : '—'} foot={hasAny ? (c.utilizationPct >= 98 ? 'Nearly everything you committed to is being used' : 'Part of what you pay for goes unused') : 'Nothing committed'} hint="Share of your commitments that was actually used." tone={hasAny && c.utilizationPct < 90 ? 'crit' : undefined} />
        <Kpi label="Wasted commitment" value={money(c.monthlyWaste)} foot="Paid for but unused, last 30 days" hint="Commitment you paid for with no matching usage." tone={c.monthlyWaste > 50 ? 'warn' : undefined} />
      </div>

      {/* ── Renewals ── */}
      <div className="section-h">
        <h2>Coming up for renewal</h2>
        <p>Next 12 months</p>
      </div>
      {c.expirations.length === 0 ? (
        <Empty title={hasAny ? 'Nothing expires in the next 12 months' : 'Nothing to renew'} icon="commit">
          {hasAny ? 'Your existing commitments all run for more than a year.' : 'This account holds no Savings Plans or reservations.'}
        </Empty>
      ) : (
        <div className="card">
          <div className="pad" style={{ paddingBottom: 6 }}>
            <div className="tl" aria-hidden>
              <div className="tl-zone" style={{ left: 0, width: `${(90 / span) * 100}%` }} title="Next 90 days" />
              <div className="tl-axis" />
              {months.map((m, i) =>
                i === 0 ? null : (
                  <span key={m}>
                    <div className="tl-tick" style={{ left: `${pos(m)}%` }} />
                    {i < 12 && (
                      <div className="tl-month" style={{ left: `${pos(m) + 4}%` }}>
                        {monthShort(m)}
                      </div>
                    )}
                  </span>
                ),
              )}
              <div className="tl-month" style={{ left: 0, transform: 'none', color: 'var(--ink)', fontWeight: 600 }}>
                Today
              </div>
              {c.expirations.map((e, i) => (
                <div key={e.id} className="tl-pin" style={{ left: `${pos(e.end)}%`, color: e.daysLeft <= 30 ? 'var(--crit)' : e.daysLeft <= 90 ? 'var(--serious)' : 'var(--muted)', top: i % 2 ? 14 : 0 }} title={`${e.label} — ${fmtDateLong(e.end)}`}>
                  <b style={{ color: 'var(--ink)' }}>{money(e.monthlyExposure, { compact: true })}/mo</b>
                  <div className="stem" style={{ height: i % 2 ? 0 : 12 }} />
                  <div className="head" />
                </div>
              ))}
            </div>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ paddingLeft: 22 }}>Expires</th>
                <th>Commitment</th>
                <th className="r">Committed / mo</th>
                <th className="r">Used</th>
                <th className="r" style={{ paddingRight: 22 }}>
                  Discount at risk
                </th>
              </tr>
            </thead>
            <tbody>
              {c.expirations.map((e) => (
                <tr key={e.id}>
                  <td style={{ paddingLeft: 22, whiteSpace: 'nowrap' }}>
                    <span className={`badge ${e.daysLeft <= 30 ? 'crit' : e.daysLeft <= 90 ? 'warn' : ''}`}>{e.daysLeft} days</span>
                    <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                      {fmtDateLong(e.end)}
                    </div>
                  </td>
                  <td>
                    <div style={{ fontWeight: 550 }}>{e.label}</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      {e.detail}
                    </div>
                  </td>
                  <td className="r">{money(e.monthlyCommitment)}</td>
                  <td className="r">{pct(e.utilizationPct)}</td>
                  <td className="r" style={{ paddingRight: 22, fontWeight: 600 }}>
                    {money(e.monthlyExposure)}/mo
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Reserve now ── */}
      <div className="section-h">
        <h2>Reserve right away</h2>
        <p>{buyTotal > 0 ? `${money(buyTotal)}/month, no infrastructure changes` : ''}</p>
      </div>
      {buy.length === 0 ? (
        <Empty title="Nothing more to buy right now" icon="check">
          AWS has no purchase recommendations based on the last 30 days of usage{snap.meta.warnings.some((w) => /recommend|savings|reservation/i.test(w.section)) ? ' — but part of the commitment scan could not run (see Settings)' : ''}.
        </Empty>
      ) : (
        <div className="card rows">
          {buy.map((i, k) => (
            <InsightRow key={i.id} i={i} defaultOpen={k === 0} />
          ))}
        </div>
      )}

      <Planner />

      {unused.length > 0 && (
        <>
          <div className="section-h">
            <h2>Paid for but not used</h2>
            <p>{money(unused.reduce((a, i) => a + i.monthlySavings, 0))}/month</p>
          </div>
          <div className="card rows">
            {unused.map((i) => (
              <InsightRow key={i.id} i={i} />
            ))}
          </div>
        </>
      )}

      {/* ── Coverage ── */}
      {raw.coverage.length > 1 && (
        <>
          <div className="section-h">
            <h2>Coverage over time</h2>
            <p>Eligible usage per day, valued at on-demand rates</p>
          </div>
          <div className="card pad">
            <TimeChart
              kind="stack"
              dates={raw.coverage.map((p) => p.date)}
              series={[
                { name: 'Covered by commitments', color: 'var(--s1)', values: raw.coverage.map((p) => p.covered) },
                { name: 'On-demand', color: 'var(--s2)', values: raw.coverage.map((p) => p.onDemand) },
              ]}
              height={210}
            />
            <div style={{ marginTop: 10 }}>
              <Legend
                items={[
                  { name: 'Covered by commitments', color: 'var(--s1)' },
                  { name: 'On-demand (could be discounted)', color: 'var(--s2)' },
                ]}
              />
            </div>
          </div>
          {raw.coverageByService.length > 0 && (
            <div className="card" style={{ marginTop: 14, overflow: 'hidden' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ paddingLeft: 22 }}>Service</th>
                    <th>Discount type</th>
                    <th style={{ width: 220 }}>Coverage</th>
                    <th className="r" style={{ paddingRight: 22 }}>
                      On-demand, last 30 days
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...raw.coverageByService]
                    .sort((a, b) => b.onDemandCost - a.onDemandCost)
                    .map((x) => (
                      <tr key={x.service + x.kind} className="click" onClick={() => s.pullThread({ label: shortService(x.service), filters: { SERVICE: [x.service] }, groupBy: 'USAGE_TYPE' })}>
                        <td style={{ paddingLeft: 22, fontWeight: 550 }}>{shortService(x.service)}</td>
                        <td className="ink2">{x.kind === 'SP' ? 'Savings Plan' : 'Reservation'}</td>
                        <td>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <div className="bar-track" style={{ flex: 1, background: 'color-mix(in srgb, var(--s1) 18%, var(--surface))' }}>
                              <div className="bar-fill" style={{ width: `${x.coveragePct}%`, background: 'var(--s1)' }} />
                            </div>
                            <span className="num" style={{ width: 36, textAlign: 'right' }}>
                              {pct(x.coveragePct)}
                            </span>
                          </div>
                        </td>
                        <td className="r" style={{ paddingRight: 22, fontWeight: 600 }}>
                          {money(x.onDemandCost)}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Inventory ── */}
      {hasAny && (
        <>
          <div className="section-h">
            <h2>What you hold</h2>
            <p>
              {raw.savingsPlans.length} Savings Plan{raw.savingsPlans.length === 1 ? '' : 's'} · {raw.reservations.length} reservation{raw.reservations.length === 1 ? '' : 's'}
            </p>
          </div>
          <div className="card" style={{ overflow: 'hidden' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ paddingLeft: 22 }}>Commitment</th>
                  <th>Term</th>
                  <th>Ends</th>
                  <th className="r">Cost, 30 days</th>
                  <th className="r">Utilization</th>
                  <th className="r" style={{ paddingRight: 22 }}>
                    Net savings, 30 days
                  </th>
                </tr>
              </thead>
              <tbody>
                {raw.savingsPlans.map((sp) => (
                  <tr key={sp.id}>
                    <td style={{ paddingLeft: 22 }}>
                      <div style={{ fontWeight: 550 }}>{sp.type === 'EC2Instance' ? 'EC2 Instance' : sp.type} Savings Plan</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {money(sp.hourlyCommitment, { cents: true })}/hour{sp.instanceFamily ? ` · ${sp.instanceFamily} · ${sp.region}` : ''}
                      </div>
                    </td>
                    <td className="ink2">
                      {sp.termYears}-year · {sp.paymentOption}
                    </td>
                    <td className="ink2" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDateLong(sp.end)}
                    </td>
                    <td className="r">{money(sp.usedCommitment + sp.unusedCommitment)}</td>
                    <td className="r">
                      <UtilBadge v={sp.utilizationPct} />
                    </td>
                    <td className="r" style={{ paddingRight: 22, fontWeight: 600 }}>
                      {money(sp.netSavings)}
                    </td>
                  </tr>
                ))}
                {raw.reservations.map((ri) => (
                  <tr key={ri.id}>
                    <td style={{ paddingLeft: 22 }}>
                      <div style={{ fontWeight: 550 }}>
                        {shortService(ri.service)} · {ri.count} × {ri.instanceType}
                      </div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {[ri.platform, ri.region].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="ink2">{[ri.termYears ? `${ri.termYears}-year` : '', ri.offeringType].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="ink2" style={{ whiteSpace: 'nowrap' }}>
                      {fmtDateLong(ri.end)}
                    </td>
                    <td className="r">{money(ri.amortizedCost)}</td>
                    <td className="r">
                      <UtilBadge v={ri.utilizationPct} />
                    </td>
                    <td className="r" style={{ paddingRight: 22, fontWeight: 600 }}>
                      {money(ri.netSavings)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function UtilBadge({ v }: { v: number }) {
  return <span className={`badge ${v >= 95 ? 'good' : v >= 80 ? 'warn' : 'crit'}`}>{pct(v)}</span>;
}

function Kpi({ label, value, foot, hint, tone }: { label: string; value: string; foot: string; hint: string; tone?: 'warn' | 'crit' }) {
  return (
    <div className="card tile" title={hint}>
      <div className="label">
        {label}
        <span className="muted">
          <Icon name="info" size={14} />
        </span>
      </div>
      <div className="value">{value}</div>
      <div className="foot">
        {tone && <span className="dot" style={{ background: tone === 'crit' ? 'var(--crit)' : 'var(--warn)' }} />}
        {foot}
      </div>
    </div>
  );
}
