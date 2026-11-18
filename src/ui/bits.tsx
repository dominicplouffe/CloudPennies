import type { ReactNode } from 'react';
import type { InsightCategory, Level } from '../core/types';
import { money, pct, pctChange } from '../core/util';

const PATHS: Record<string, string> = {
  brief: 'M4 5h12v14H6a2 2 0 0 1-2-2V5zm12 4h4v8a2 2 0 0 1-4 0M8 9h4M8 13h4',
  explore: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm3.5-12.5-2 5-5 2 2-5 5-2z',
  anomaly: 'M3 12h4l3-8 4 16 3-8h4',
  savings: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm3-11.5a3.5 3.5 0 1 0 0 5M12 6v12',
  commit: 'M5 5h14v15H5zM5 10h14M9 3v4M15 3v4M9 15l2 2 4-4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8-3 2-1-2-4-2 1a7 7 0 0 0-2-1l-.5-2h-4L11 7a7 7 0 0 0-2 1L7 7 5 11l2 1a7 7 0 0 0 0 2l-2 1 2 4 2-1a7 7 0 0 0 2 1l.5 2h4l.5-2a7 7 0 0 0 2-1l2 1 2-4-2-1a7 7 0 0 0 0-2z',
  refresh: 'M20 11a8 8 0 0 0-14.5-4.5L4 8m0-4v4h4m-4 5a8 8 0 0 0 14.500 4.5L20 16m0 4v-4h-4',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  chev: 'm9 6 6 6-6 6',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5 9-10',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  lock: 'M6 11h12v9H6zm2 0V8a4 4 0 0 1 8 0v3',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6l1-7z',
  download: 'M12 4v11m-5-5 5 5 5-5M5 20h14',
  alert: 'M12 4 2.500 20h19L12 4zm0 6v5m0 2.500v.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-10v6m0-9v.5',
  up: 'M12 19V6m-5 5 5-5 5 5',
  down: 'M12 5v13m-5-5 5 5 5-5',
  trash: 'M5 7h14M10 7V4h4v3m-7 0 1 13h8l1-13',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4V8zm0 0 8 4 8-4m-8 4v8',
  net: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  resize: 'M4 14v6h6M20 10V4h-6M4 20l7-7m9-9-7 7',
  shield: 'M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3z',
  spark: 'M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.500 2.500m7 7L18 18M18 6l-2.500 2.500m-7 7L6 18',
  ext: 'M14 5h5v5m0-5-8 8M11 7H5v12h12v-6',
  undo: 'M9 7 4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2',
};

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flex: 'none' }}>
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}

export const CATEGORY: Record<InsightCategory, { label: string; icon: string; color: string }> = {
  commitments: { label: 'Commitments', icon: 'commit', color: 'var(--s1)' },
  idle: { label: 'Idle & unused', icon: 'trash', color: 'var(--s2)' },
  rightsizing: { label: 'Rightsizing', icon: 'resize', color: 'var(--s3)' },
  observability: { label: 'Logs & monitoring', icon: 'eye', color: 'var(--s4)' },
  modernize: { label: 'Modernize', icon: 'spark', color: 'var(--s5)' },
  storage: { label: 'Storage', icon: 'box', color: 'var(--s6)' },
  network: { label: 'Network', icon: 'net', color: 'var(--s7)' },
  governance: { label: 'Governance', icon: 'shield', color: 'var(--s8)' },
};

/** change badge where UP is bad (costs) */
export function Delta({ cur, prev, showMoney }: { cur: number; prev: number; showMoney?: boolean }) {
  const d = cur - prev;
  const p = pctChange(cur, prev);
  if (Math.abs(d) < 0.5 || (isFinite(p) && Math.abs(p) < 0.5)) return <span className="delta muted">—</span>;
  const up = d > 0;
  return (
    <span className={`delta ${up ? 'up' : 'down'}`}>
      <Icon name={up ? 'up' : 'down'} size={13} />
      {showMoney ? money(Math.abs(d)) : isFinite(p) ? pct(Math.abs(p)) : 'new'}
    </span>
  );
}

export function LevelBadge({ kind, level }: { kind: 'effort' | 'confidence' | 'risk'; level: Level }) {
  const good = kind === 'confidence' ? level === 'high' : level === 'low';
  const bad = kind === 'confidence' ? level === 'low' : level === 'high';
  const label = kind === 'effort' ? `${cap(level)} effort` : kind === 'risk' ? `${cap(level)} risk` : level === 'high' ? 'Firm number' : level === 'medium' ? 'Good estimate' : 'Rough estimate';
  return <span className={`badge ${good ? 'good' : bad && kind !== 'confidence' ? 'warn' : ''}`}>{label}</span>;
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function Empty({ title, children, icon = 'check' }: { title: string; children?: ReactNode; icon?: string }) {
  return (
    <div className="card pad" style={{ textAlign: 'center', padding: '44px 24px' }}>
      <div style={{ color: 'var(--good-ink)', display: 'inline-grid', placeItems: 'center', width: 44, height: 44, borderRadius: 22, background: 'var(--good-wash)', marginBottom: 12 }}>
        <Icon name={icon} size={22} />
      </div>
      <h3 style={{ fontSize: 16 }}>{title}</h3>
      <p className="ink2" style={{ maxWidth: 440, margin: '6px auto 0' }}>
        {children}
      </p>
    </div>
  );
}

export function PageHead({ eyebrow, title, sub, right }: { eyebrow?: string; title: ReactNode; sub?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'flex-start' }}>
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="page-title" style={{ marginTop: eyebrow ? 6 : 0 }}>
          {title}
        </h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {right && <div style={{ display: 'flex', gap: 8, flex: 'none' }}>{right}</div>}
    </div>
  );
}
