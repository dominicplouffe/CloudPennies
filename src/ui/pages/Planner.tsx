import { useMemo, useState } from 'react';
import { breakEvenDrop, curve, model, optionKey, plannerData, presets, type PlanOption } from '../../core/commitmentModel';
import { money, pct } from '../../core/util';
import { Icon } from '../bits';
import { CurveChart } from '../charts';
import { useStore } from '../store';

const perHour = (x: number) => `$${x.toFixed(2)}/hr`;

/** "What if I commit this much?" — the questions AWS's single recommendation does not answer */
export function Planner() {
  const s = useStore();
  const snap = s.snapshot!;
  const data = useMemo(() => plannerData(snap), [snap]);
  const [term, setTerm] = useState<1 | 3>(1);
  const [payment, setPayment] = useState<PlanOption['payment']>('No Upfront');
  const [include, setInclude] = useState<Record<string, boolean>>(() => Object.fromEntries(data.expiring.filter((e) => e.daysLeft <= 60).map((e) => [e.id, true])));
  const [drop, setDrop] = useState(0);
  const [hourlyRaw, setHourly] = useState<number | null>(null);

  const option = data.options.find((o) => o.termYears === term && o.payment === payment)!;
  // usage covered by plans that are about to end comes back as on-demand
  const extra = data.expiring.filter((e) => include[e.id]).reduce((a, e) => a + e.dailyOnDemand, 0);
  const daily = useMemo(() => data.daily.map((d) => d + extra), [data.daily, extra]);
  const aws = data.awsHourly[optionKey(option)] ?? null;
  const pre = useMemo(() => presets(daily, option.discount, aws), [daily, option.discount, aws]);
  const hourly = Math.min(pre.max, hourlyRaw ?? pre.best);
  const pts = useMemo(() => curve(daily, option.discount, pre.max).map((p) => ({ x: p.hourly, y: p.savings })), [daily, option.discount, pre.max]);

  if (!data.usable) return null;

  const base = model({ daily, discount: option.discount, hourly });
  const stressed = model({ daily, discount: option.discount, hourly, usageDrop: drop });
  const be = breakEvenDrop(daily, option.discount, hourly);
  const locked = hourly * 8760 * term;
  const step = pre.max > 20 ? 0.25 : pre.max > 4 ? 0.05 : 0.01;
  const markers = [
    { x: pre.safe, label: 'Safe' },
    { x: pre.best, label: 'Best fit' },
    ...(pre.aws !== null && Math.abs(pre.aws - pre.best) > pre.max * 0.04 ? [{ x: pre.aws, label: 'AWS suggests' }] : []),
  ].filter((mk) => mk.x > 0);

  const verdict =
    hourly <= 0
      ? 'Move the slider to see what a commitment would save.'
      : base.monthlySavings <= 0
        ? `At ${perHour(hourly)} the plan would cost more than it saves on your current usage.`
        : hourly <= pre.safe * 1.02
          ? `This is the cautious choice: the plan would have been fully used on every one of the last ${base.days} days. You leave ${money(model({ daily, discount: option.discount, hourly: pre.best }).monthlySavings - base.monthlySavings)}/month on the table compared with the best fit.`
          : hourly <= pre.best * 1.02
            ? `Close to the sweet spot. The plan would have gone partly unused on ${base.daysNotFullyUsed} of the last ${base.days} days, which costs ${money(base.monthlyUnused)}/month — already netted out of the saving shown.`
            : `Above the sweet spot: you would pay for ${money(base.monthlyUnused)}/month of commitment you do not use. A smaller plan saves more.`;

  return (
    <>
      <div className="section-h">
        <h2>Plan a purchase</h2>
        <p>What happens at other commitment levels, and if usage falls</p>
      </div>
      <div className="card pad">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="seg">
            {([1, 3] as const).map((t) => (
              <button key={t} className={term === t ? 'on' : ''} onClick={() => { setTerm(t); setHourly(null); }}>
                {t}-year
              </button>
            ))}
          </div>
          <div className="seg">
            {(['No Upfront', 'Partial Upfront', 'All Upfront'] as const).map((p) => (
              <button key={p} className={payment === p ? 'on' : ''} onClick={() => { setPayment(p); setHourly(null); }}>
                {p}
              </button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12.5 }} title={option.source === 'aws' ? "Derived from AWS's own purchase recommendation for this option." : 'AWS gave no recommendation for this option, so a typical Compute Savings Plan discount is assumed. Real rates vary by instance family and region.'}>
            {pct(option.discount * 100)} average discount {option.source === 'aws' ? '(from AWS)' : '(typical — AWS gave no figure)'}
          </span>
        </div>

        {data.expiring.length > 0 && (
          <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
            {data.expiring.map((e) => (
              <label key={e.id} style={{ display: 'flex', gap: 8, fontSize: 13, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={!!include[e.id]} onChange={(ev) => { setInclude({ ...include, [e.id]: ev.target.checked }); setHourly(null); }} style={{ marginTop: 3 }} />
                <span>
                  Plan for the <b>{e.label}</b> ending in {e.daysLeft} days. The {money(e.dailyOnDemand * 30.4)}/month of usage it covers goes back to on-demand then, so a replacement needs to cover it too.
                </span>
              </label>
            ))}
          </div>
        )}

        <div style={{ marginTop: 18 }}>
          <CurveChart points={pts} markers={markers} current={hourly} xFormat={perHour} yFormat={(y) => money(y, { compact: true })} onPick={(x) => setHourly(Math.round(x / step) * step)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)', gap: 28, marginTop: 14, alignItems: 'start' }}>
          <div>
            <label className="field">
              Commitment: <b style={{ color: 'var(--ink)' }}>{perHour(hourly)}</b> <span className="muted">({money(base.monthlyPlanCost)}/month)</span>
              <input type="range" min={0} max={pre.max} step={step} value={hourly} onChange={(e) => setHourly(Number(e.target.value))} style={{ width: '100%', marginTop: 8, accentColor: 'var(--accent)' }} />
            </label>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn sm" onClick={() => setHourly(pre.safe)} title="Fully used even on the quietest day of the last 90">
                Safe · {perHour(pre.safe)}
              </button>
              <button className="btn sm" onClick={() => setHourly(pre.best)} title="The commitment with the highest savings over the last 90 days">
                Best fit · {perHour(pre.best)}
              </button>
              {pre.aws !== null && (
                <button className="btn sm" onClick={() => setHourly(pre.aws!)} title="AWS's purchase recommendation for this term and payment option">
                  AWS suggests · {perHour(pre.aws)}
                </button>
              )}
            </div>
            <p className="ink2" style={{ fontSize: 13, marginTop: 12 }}>
              {verdict}
            </p>
            <label className="field" style={{ marginTop: 16 }}>
              If usage falls by <b style={{ color: 'var(--ink)' }}>{pct(drop * 100)}</b>
              <input type="range" min={0} max={0.6} step={0.05} value={drop} onChange={(e) => setDrop(Number(e.target.value))} style={{ width: '100%', marginTop: 8, accentColor: 'var(--accent)' }} />
            </label>
          </div>
          <dl className="kv" style={{ rowGap: 9 }}>
            <dt title="Compared with paying on-demand rates for the same usage, including usage whose current plan is about to end if you ticked it above.">Saves vs on-demand{drop > 0 ? ` (usage −${pct(drop * 100)})` : ''}</dt>
            <dd style={{ fontSize: 17, color: stressed.monthlySavings < 0 ? 'var(--crit-ink)' : undefined }}>{money(stressed.monthlySavings)}/mo</dd>
            <dt>Commitment used</dt>
            <dd>{pct(stressed.utilizationPct)}</dd>
            <dt>Eligible usage covered</dt>
            <dd>{pct(stressed.coveragePct)}</dd>
            <dt>Left on-demand</dt>
            <dd>{money(stressed.monthlyOnDemandLeft)}/mo</dd>
            <dt>Usage can fall before it stops paying off</dt>
            <dd>{be >= 0.99 ? 'more than 95%' : be <= 0 ? '—' : pct(be * 100)}</dd>
            <dt>Locked in over {term} year{term === 1 ? '' : 's'}</dt>
            <dd>{money(locked, { compact: true })}</dd>
          </dl>
        </div>

        {pre.best > pre.safe * 1.05 && (
          <div className="note" style={{ marginTop: 16 }}>
            <Icon name="info" size={16} />
            <span>
              <b>A lower-risk way to get there:</b> buy {perHour(pre.safe)} now — it is used fully even on your quietest day — then add up to {perHour(pre.best - pre.safe)} in a month once you have seen it apply. Separate purchases also end on different dates, so you are never renegotiating everything at once.
            </span>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 12 }}>
          Modelled on {base.days} days of daily usage ({money(data.monthlyEligible)}/month of on-demand compute that a Compute Savings Plan can cover). Plans apply hour by hour, so workloads that swing a lot within a day will use a plan somewhat less fully than shown. The discount is an average; your real rate depends on instance family and region. This is a planning aid, not a quote.
        </p>
      </div>
    </>
  );
}
