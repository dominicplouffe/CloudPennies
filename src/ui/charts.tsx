import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fmtDate, money, monthShort, parseIso } from '../core/util';

export const SERIES_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
export const OTHER_COLOR = 'var(--s-other)';

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    setW(ref.current.clientWidth);
    const ro = new ResizeObserver((e) => setW(e[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.01; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

const axisMoney = (v: number, top: number) => (top >= 10000 ? `$${(v / 1000).toFixed(top >= 100000 ? 0 : v % 1000 === 0 ? 0 : 1)}K` : `$${v.toLocaleString('en-US')}`);

export interface Series {
  name: string;
  color: string;
  values: number[];
}

export interface Marker {
  date: string;
  label: string;
  onClick?: () => void;
}

interface TimeChartProps {
  dates: string[];
  series: Series[];
  kind: 'area' | 'stack';
  height?: number;
  monthly?: boolean;
  markers?: Marker[];
  /** shaded date range [from, to] */
  band?: [string, string];
  /** optional dashed reference line, same length as dates */
  reference?: { name: string; values: number[] };
  /** index from which the single series should be drawn as a projection (lighter) */
  ghostFrom?: number;
}

export function TimeChart({ dates, series, kind, height = 220, monthly, markers, band, reference, ghostFrom }: TimeChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = dates.length;
  const m = { l: 44, r: 12, t: 12, b: 24 };
  const iw = Math.max(10, width - m.l - m.r);
  const ih = height - m.t - m.b;

  const totals = useMemo(() => dates.map((_, i) => (kind === 'stack' ? series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0) : Math.max(...series.map((s) => s.values[i] ?? 0), reference?.values[i] ?? 0))), [dates, series, kind, reference]);
  const ticks = niceTicks(Math.max(...totals, 1) * 1.02);
  const top = ticks[ticks.length - 1];
  const y = (v: number) => m.t + ih - (v / top) * ih;
  const band_ = iw / Math.max(1, n);
  const xc = (i: number) => (kind === 'stack' ? m.l + band_ * (i + 0.5) : m.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1)));

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 78))));
  const xLabel = (d: string) => (monthly ? `${monthShort(d)}${parseIso(d).getUTCMonth() === 0 ? ` ’${String(parseIso(d).getUTCFullYear()).slice(2)}` : ''}` : fmtDate(d));

  const onMove = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left - m.l;
    const i = kind === 'stack' ? Math.floor(px / band_) : Math.round((px / iw) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };

  const barW = Math.min(24, Math.max(1, Math.floor(band_ - (band_ > 6 ? 2 : band_ > 3 ? 1 : 0))));
  const segGap = barW >= 6 ? 2 : barW >= 3 ? 1 : 0;

  return (
    <div className="chart" ref={ref} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label={`${series.map((s) => s.name).join(', ')} over time`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={width - m.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
              <text x={m.l - 8} y={y(t) + 4} textAnchor="end">
                {axisMoney(t, top)}
              </text>
            </g>
          ))}
          {band && (() => {
            const a = dates.indexOf(band[0]);
            const b = dates.indexOf(band[1]);
            if (a < 0 || b < 0) return null;
            const half = kind === 'stack' ? band_ / 2 : Math.max(3, iw / Math.max(1, n - 1) / 2);
            return <rect x={xc(a) - half} width={xc(b) - xc(a) + half * 2} y={m.t} height={ih} fill="var(--crit-wash)" opacity={0.7} rx={4} />;
          })()}
          {dates.map((d, i) =>
            i % labelEvery === 0 && xc(i) < width - 24 ? (
              <text key={d} x={xc(i)} y={height - 6} textAnchor="middle">
                {xLabel(d)}
              </text>
            ) : null,
          )}

          {kind === 'stack' &&
            dates.map((d, i) => {
              let acc = 0;
              const live = series.map((s, si) => ({ s, si, v: Math.max(0, s.values[i] ?? 0) })).filter((x) => x.v > 0);
              return (
                <g key={d} opacity={hover === null || hover === i ? 1 : 0.55}>
                  {live.map(({ s, v }, k) => {
                    const y0 = y(acc);
                    acc += v;
                    const y1 = y(acc);
                    const h = Math.max(0.5, y0 - y1 - (k < live.length - 1 ? segGap : 0));
                    const isTop = k === live.length - 1;
                    const r = isTop ? Math.min(4, barW / 2, h) : 0;
                    const x = Math.round(xc(i) - barW / 2);
                    const yy = y0 - h;
                    return r > 0 ? (
                      <path key={s.name} d={`M${x},${yy + h}V${yy + r}a${r},${r} 0 0 1 ${r},${-r}h${barW - 2 * r}a${r},${r} 0 0 1 ${r},${r}V${yy + h}z`} fill={s.color} />
                    ) : (
                      <rect key={s.name} x={x} y={yy} width={barW} height={h} fill={s.color} />
                    );
                  })}
                </g>
              );
            })}

          {kind === 'area' &&
            series.map((s) => {
              const cut = ghostFrom ?? n;
              const pts = s.values.map((v, i) => `${xc(i)},${y(v)}`);
              const solid = pts.slice(0, cut);
              const ghost = pts.slice(Math.max(0, cut - 1));
              return (
                <g key={s.name}>
                  {solid.length > 1 && <path d={`M${solid.join('L')}L${xc(solid.length - 1)},${y(0)}L${xc(0)},${y(0)}Z`} fill={s.color} opacity={0.1} />}
                  {solid.length > 1 && <path d={`M${solid.join('L')}`} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
                  {ghost.length > 1 && <path d={`M${ghost.join('L')}`} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray="2 5" strokeLinecap="round" opacity={0.7} />}
                </g>
              );
            })}
          {reference && <path d={`M${reference.values.map((v, i) => `${xc(i)},${y(v)}`).join('L')}`} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeDasharray="4 4" />}

          <line x1={m.l} x2={width - m.r} y1={y(0)} y2={y(0)} stroke="var(--line-2)" strokeWidth={1} />

          {markers?.map((mk, k) => {
            const i = dates.indexOf(mk.date);
            if (i < 0) return null;
            const v = kind === 'stack' ? totals[i] : (series[0]?.values[i] ?? 0);
            return (
              <g key={k} style={{ cursor: mk.onClick ? 'pointer' : undefined }} onClick={mk.onClick}>
                <circle cx={xc(i)} cy={y(v) - (kind === 'stack' ? 10 : 0)} r={12} fill="transparent" />
                <circle cx={xc(i)} cy={y(v) - (kind === 'stack' ? 10 : 0)} r={5} fill="var(--crit)" stroke="var(--surface)" strokeWidth={2} />
                <title>{mk.label}</title>
              </g>
            );
          })}

          {hover !== null && kind === 'area' && (
            <g pointerEvents="none">
              <line x1={xc(hover)} x2={xc(hover)} y1={m.t} y2={y(0)} stroke="var(--line-2)" />
              {series.map((s) => (
                <circle key={s.name} cx={xc(hover)} cy={y(s.values[hover] ?? 0)} r={4.5} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover !== null && width > 0 && (
        <div className="tip" style={xc(hover) > width * 0.6 ? { right: width - xc(hover) + 14, top: 8 } : { left: xc(hover) + 14, top: 8 }}>
          <div className="t">{monthly ? `${monthShort(dates[hover])} ${parseIso(dates[hover]).getUTCFullYear()}` : fmtDate(dates[hover])}</div>
          {[...series]
            .reverse()
            .filter((s) => (s.values[hover] ?? 0) !== 0 || series.length === 1)
            .map((s) => (
              <div className="r" key={s.name}>
                <span>
                  <i className="k" style={{ background: s.color }} />
                  {s.name}
                </span>
                <b>{money(s.values[hover] ?? 0)}</b>
              </div>
            ))}
          {reference && (
            <div className="r">
              <span>
                <i className="k" style={{ background: 'var(--muted)' }} />
                {reference.name}
              </span>
              <b>{money(reference.values[hover] ?? 0)}</b>
            </div>
          )}
          {kind === 'stack' && series.length > 1 && (
            <div className="r" style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid rgba(128,128,128,.4)' }}>
              <span>Total</span>
              <b>{money(totals[hover])}</b>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Spark({ values, width = 96, height = 26, color = 'var(--muted)' }: { values: number[]; width?: number; height?: number; color?: string }) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const max = Math.max(...values, 0.0001);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (width - 6) + 1},${height - 3 - (v / max) * (height - 6)}`);
  const last = pts[pts.length - 1].split(',');
  return (
    <svg width={width} height={height} aria-hidden>
      <path d={`M${pts.join('L')}`} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="var(--accent)" />
    </svg>
  );
}

/** One whole split into parts — thin variant */
export function Segments({ parts, height = 8 }: { parts: { label: string; value: number; color: string }[]; height?: number }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div style={{ display: 'flex', gap: 2, height, width: '100%' }} role="img" aria-label={parts.map((p) => `${p.label} ${money(p.value)}`).join(', ')}>
      {parts
        .filter((p) => p.value > 0)
        .map((p) => (
          <div key={p.label} title={`${p.label}: ${money(p.value)} (${((p.value / total) * 100).toFixed(0)}%)`} style={{ flex: p.value, background: p.color, borderRadius: height / 2, minWidth: 3 }} />
        ))}
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color: string; extra?: ReactNode }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span key={i.name}>
          <i style={{ background: i.color }} />
          {i.name}
          {i.extra}
        </span>
      ))}
    </div>
  );
}

export function Meter({ value, max, tone }: { value: number; max: number; tone?: 'good' | 'warn' | 'crit' }) {
  const p = Math.min(100, max > 0 ? (value / max) * 100 : 0);
  const color = tone === 'crit' ? 'var(--crit)' : tone === 'warn' ? 'var(--warn)' : tone === 'good' ? 'var(--good)' : 'var(--accent)';
  return (
    <div className="bar-track" style={{ height: 8, borderRadius: 4 }}>
      <div className="bar-fill" style={{ width: `${p}%`, background: color, borderRadius: 4 }} />
    </div>
  );
}

export function useDelayed<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
