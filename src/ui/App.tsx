import { money } from '../core/util';
import { Icon } from './bits';
import { Anomalies } from './pages/Anomalies';
import { Briefing } from './pages/Briefing';
import { Commitments } from './pages/Commitments';
import { Explore } from './pages/Explore';
import { Savings } from './pages/Savings';
import { SettingsPage } from './pages/Settings';
import { Welcome } from './pages/Welcome';
import { bridge, useStore, type Page } from './store';

const isMac = bridge?.platform === 'darwin';

export function App() {
  const s = useStore();
  if (s.phase === 'loading') return <div className={isMac ? 'mac' : ''} />;
  if (s.phase === 'welcome') return <div className={isMac ? 'mac' : ''} style={{ height: '100%' }}><Welcome /></div>;

  const r = s.report;
  const ongoing = r?.anomalies.filter((a) => a.ongoing).length ?? 0;
  const soon = r?.commitments.expirations.filter((e) => e.daysLeft <= 60).length ?? 0;
  const savings = r ? r.insights.filter((i) => !s.dismissed.has(i.id)).reduce((a, i) => a + i.monthlySavings, 0) : 0;

  const NAV: { id: Page; label: string; icon: string; count?: string; tone?: string }[] = [
    { id: 'briefing', label: 'Briefing', icon: 'brief' },
    { id: 'explore', label: 'Explore', icon: 'explore' },
    { id: 'anomalies', label: 'Anomalies', icon: 'anomaly', count: ongoing ? String(ongoing) : undefined, tone: 'hot' },
    { id: 'savings', label: 'Savings', icon: 'savings', count: savings > 0 ? money(savings, { compact: true }) : undefined, tone: 'money' },
    { id: 'commitments', label: 'Commitments', icon: 'commit', count: soon ? String(soon) : undefined, tone: 'hot' },
  ];

  const pct = s.scanning ? (s.scanning.total > 0 ? (s.scanning.done / s.scanning.total) * 100 : 0) : 0;

  return (
    <div className={`shell ${isMac ? 'mac' : ''}`}>
      <aside className="side">
        <div className="brand">
          <img src="./logo.svg" alt="" />
          <div>
            <b>CloudPennies</b>
            <span>Every cloud dollar has a story</span>
          </div>
        </div>
        <nav className="nav">
          {NAV.map((n) => (
            <button key={n.id} className={s.page === n.id ? 'on' : ''} onClick={() => s.setPage(n.id)} disabled={!r && n.id !== 'briefing'}>
              <Icon name={n.icon} />
              {n.label}
              {n.count && <span className={`count ${n.tone}`}>{n.count}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <UpdateBanner />
          <div className="acct">
            <span>{s.snapshot?.meta.mode === 'demo' ? 'Demo data' : 'AWS account'}</span>
            <b title={s.snapshot?.meta.accountLabel}>{s.snapshot?.meta.accountLabel ?? s.connection.accountId ?? 'Connecting…'}</b>
            <div className="row">
              {s.snapshot?.meta.mode === 'demo' ? (
                <button className="btn sm" onClick={() => void s.disconnect()}>
                  Connect AWS
                </button>
              ) : (
                <button className="btn sm" onClick={() => void s.rescan()} disabled={!!s.scanning}>
                  <span className={s.scanning ? 'spin' : ''} style={{ display: 'inline-flex' }}>
                    <Icon name="refresh" size={13} />
                  </span>
                  Refresh
                </button>
              )}
            </div>
          </div>
          <nav className="nav">
            <button className={s.page === 'settings' ? 'on' : ''} onClick={() => s.setPage('settings')}>
              <Icon name="settings" />
              Settings
            </button>
          </nav>
        </div>
      </aside>
      <main className="main">
        {isMac && <div className="drag-strip" />}
        {s.scanning && (
          <div className="scan-bar">
            <span className="spin" style={{ display: 'inline-flex' }}>
              <Icon name="refresh" size={14} />
            </span>
            <span>Reading your AWS bill — {s.scanning.step}</span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${pct}%`, transition: 'width .3s' }} />
            </div>
          </div>
        )}
        <div className="page fade" key={s.page}>
          {s.scanError && (
            <div className="note err" style={{ marginBottom: 20 }}>
              <Icon name="alert" size={16} />
              <div>
                <b>The scan could not finish.</b> {s.scanError}{' '}
                <button className="link" onClick={() => void s.rescan()}>
                  Try again
                </button>
              </div>
            </div>
          )}
          {s.page === 'settings' ? (
            <SettingsPage />
          ) : !r || !s.snapshot ? (
            <FirstScan />
          ) : s.page === 'briefing' ? (
            <Briefing />
          ) : s.page === 'explore' ? (
            <Explore />
          ) : s.page === 'anomalies' ? (
            <Anomalies />
          ) : s.page === 'savings' ? (
            <Savings />
          ) : (
            <Commitments />
          )}
        </div>
      </main>
    </div>
  );
}

/** Shown in the sidebar only when there is something to do about an update */
function UpdateBanner() {
  const s = useStore();
  const u = s.update;
  if (u.state !== 'ready' && u.state !== 'available') return null;
  return (
    <div className="acct" style={{ borderColor: 'var(--accent)', background: 'var(--accent-wash)' }}>
      <span>{u.state === 'ready' ? 'Update downloaded' : 'Update available'}</span>
      <b>Version {u.version ?? 'new'}</b>
      <div className="row">
        {u.state === 'ready' ? (
          <button className="btn sm primary" onClick={() => void bridge?.installUpdate()}>
            Restart to update
          </button>
        ) : (
          <button className="btn sm" onClick={() => void bridge?.openExternal(u.releaseUrl ?? 'https://github.com/dominicplouffe/CloudPennies/releases/latest')}>
            Download
          </button>
        )}
      </div>
    </div>
  );
}

function FirstScan() {
  const s = useStore();
  return (
    <div style={{ maxWidth: 560, margin: '12vh auto 0', textAlign: 'center' }}>
      <img src="./logo.svg" alt="" width={64} height={64} />
      <h1 className="page-title" style={{ marginTop: 18 }}>
        {s.scanning ? 'Reading thirteen months of billing data…' : 'No data yet'}
      </h1>
      <p className="page-sub" style={{ margin: '8px auto 0' }}>
        {s.scanning
          ? 'The first scan takes a minute or two. CloudPennies pulls cost history, commitments and AWS recommendations, then looks for anomalies and waste. Results are cached on this computer.'
          : 'Run a scan to build your briefing.'}
      </p>
      {!s.scanning && (
        <button className="btn primary" style={{ marginTop: 18 }} onClick={() => void s.rescan()}>
          <Icon name="refresh" size={15} /> Scan now
        </button>
      )}
    </div>
  );
}
