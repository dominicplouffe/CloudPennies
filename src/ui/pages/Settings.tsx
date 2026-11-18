import { useEffect, useMemo, useState } from 'react';
import { iamPolicyJson } from '../../core/iamPolicy';
import { diagnostics, reconcile } from '../../core/reconcile';
import type { Settings } from '../../core/types';
import { money } from '../../core/util';
import { Icon, PageHead } from '../bits';
import { bridge, openExternal, useStore } from '../store';
import { ConnectForm } from './Welcome';

export function SettingsPage() {
  const s = useStore();
  const snap = s.snapshot;
  const set = (patch: Partial<Settings>) => void s.saveSettings({ ...s.settings, ...patch });
  const [copied, setCopied] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const live = snap?.meta.mode === 'live' || s.connection.connected;
  const policy = iamPolicyJson(true, s.settings.memberRoleName || undefined);

  return (
    <>
      <PageHead eyebrow="Settings" title="Connection and preferences" />

      <div className="section-h">
        <h2>AWS connection</h2>
      </div>
      <div className="card pad" style={{ display: 'grid', gap: 14 }}>
        {s.connection.connected ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center' }}>
            <div>
              <b>Account {s.connection.accountId}</b>
              <div className="ink2" style={{ fontSize: 13 }}>
                {s.connection.kind === 'profile' ? `AWS profile "${s.connection.label}"` : `Access key ${s.connection.label}`} · {s.connection.arn}
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                <Icon name="lock" size={13} />
                {s.connection.kind === 'profile' ? 'Credentials are read from your AWS config files when needed; CloudPennies stores only the profile name.' : s.connection.encrypted ? 'Stored encrypted with your operating system keychain.' : 'No OS keychain is available, so the key is stored in a file only your user can read.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => void s.rescan()} disabled={!!s.scanning}>
                <Icon name="refresh" size={14} /> Scan now
              </button>
              <button className="btn" onClick={() => void s.disconnect()}>
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="ink2">{snap?.meta.mode === 'demo' ? 'You are exploring demo data. Connect an AWS account to see your own bill.' : 'Not connected.'}</div>
            {showConnect ? (
              <div style={{ maxWidth: 460 }}>
                <ConnectForm compact />
              </div>
            ) : (
              <button className="btn primary" style={{ justifySelf: 'start' }} onClick={() => setShowConnect(true)}>
                Connect AWS account
              </button>
            )}
          </>
        )}
        {snap && live && (
          <div className="muted" style={{ fontSize: 12.5 }}>
            Last scan {new Date(snap.meta.generatedAt).toLocaleString()} · {snap.meta.ceRequests} Cost Explorer requests ({money(snap.meta.ceRequests * 0.01, { cents: true })} in AWS API fees) · {snap.meta.deepScan ? `resource scan covered ${snap.meta.regionsScanned.join(', ') || 'no regions'}` : 'resource scan off'}
          </div>
        )}
      </div>

      {snap && snap.meta.warnings.length > 0 && (
        <>
          <div className="section-h">
            <h2>What the last scan could not read</h2>
            <p>Everything else still works</p>
          </div>
          <div className="card rows">
            {snap.meta.warnings.map((w, i) => (
              <div key={i} style={{ padding: '12px 22px', display: 'grid', gridTemplateColumns: '180px 1fr', gap: 16, fontSize: 13 }}>
                <b style={{ fontWeight: 600 }}>{w.section}</b>
                <div className="ink2">
                  {w.message}
                  {w.missingPermission && (
                    <>
                      {' '}
                      Add <code>{w.missingPermission}</code> to the policy to enable it.
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {snap && <DataCheck />}

      <div className="section-h">
        <h2>Organization</h2>
        <p>See resources in every account, not just the one the key belongs to</p>
      </div>
      <div className="card rows">
        <MemberRole />
      </div>

      <div className="section-h">
        <h2>Automation</h2>
        <p>So you find out without having to open the app</p>
      </div>
      <div className="card rows">
        <Row title="Scan automatically" desc="Rescan while CloudPennies is running. A scan costs a few cents in AWS API fees.">
          <div className="seg">
            {(
              [
                [0, 'Off'],
                [24, 'Daily'],
                [12, 'Every 12 h'],
                [6, 'Every 6 h'],
              ] as const
            ).map(([v, l]) => (
              <button key={v} className={s.settings.autoScanHours === v ? 'on' : ''} onClick={() => set({ autoScanHours: v })}>
                {l}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Desktop notifications" desc="When a scan finds a new anomaly, a commitment crossing 60, 30, 14, 7, 3 or 1 days to expiry, or a new savings opportunity.">
          <Toggle on={s.settings.notifications} set={(v) => set({ notifications: v })} />
        </Row>
        <Row title="Keep running in the background" desc="Closing the window leaves CloudPennies in the menu bar or system tray so scheduled scans still happen.">
          <Toggle on={s.settings.runInBackground} set={(v) => set({ runInBackground: v })} />
        </Row>
        <Row title="Open at login" desc="Start CloudPennies when you sign in to this computer.">
          <Toggle on={s.settings.launchAtLogin} set={(v) => set({ launchAtLogin: v })} />
        </Row>
        <Slack />
      </div>

      <div className="section-h">
        <h2>Analysis</h2>
      </div>
      <div className="card rows">
        <Row title="Cost basis" desc="Unblended is what appears on the invoice each day. Net unblended is the same after negotiated discounts (EDP, private pricing) — choose it if that is what your Cost Explorer shows. Amortized spreads upfront commitment fees across the days they cover — better for trends if you buy upfront Savings Plans or reservations. Takes effect on the next scan.">
          <div className="seg">
            {(
              [
                ['UnblendedCost', 'Unblended'],
                ['NetUnblendedCost', 'Net unblended'],
                ['AmortizedCost', 'Amortized'],
                ['NetAmortizedCost', 'Net amortized'],
              ] as const
            ).map(([v, l]) => (
              <button key={v} className={s.settings.costBasis === v ? 'on' : ''} onClick={() => set({ costBasis: v })}>
                {l}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Resource scan" desc="Looks inside the account (read-only) for things billing data cannot show: dashboards nobody opens, log groups that never expire, unattached disks, idle load balancers. Needs the optional permissions below.">
          <div className="seg">
            <button className={s.settings.deepScan ? 'on' : ''} onClick={() => set({ deepScan: true })}>
              On
            </button>
            <button className={!s.settings.deepScan ? 'on' : ''} onClick={() => set({ deepScan: false })}>
              Off
            </button>
          </div>
        </Row>
        <Row title="Anomaly sensitivity" desc="Ignore anomalies whose total impact is below this amount.">
          <div className="seg">
            {[10, 25, 100, 500].map((v) => (
              <button key={v} className={s.settings.anomalyMinImpact === v ? 'on' : ''} onClick={() => set({ anomalyMinImpact: v })}>
                ${v}
              </button>
            ))}
          </div>
        </Row>
        <Row title="Appearance" desc="">
          <div className="seg">
            {(['system', 'light', 'dark'] as const).map((v) => (
              <button key={v} className={s.settings.theme === v ? 'on' : ''} onClick={() => set({ theme: v })}>
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
        </Row>
        {s.dismissed.size > 0 && (
          <Row title="Dismissed opportunities" desc={`${s.dismissed.size} hidden from the Savings list.`}>
            <button className="btn sm" onClick={() => [...s.dismissed].forEach((id) => s.toggleDismissed(id))}>
              Restore all
            </button>
          </Row>
        )}
      </div>

      <div className="section-h">
        <h2>IAM policy</h2>
        <p>Read-only. Only the first statement is required.</p>
      </div>
      <div className="card pad" style={{ display: 'grid', gap: 10 }}>
        <pre className="policy" style={{ maxHeight: 280 }}>
          {policy}
        </pre>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            className="btn sm"
            onClick={() => {
              void navigator.clipboard.writeText(policy);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy policy'}
          </button>
          <span className="muted" style={{ fontSize: 12.5 }}>
            For recommendations from Cost Optimization Hub and Compute Optimizer, opt in to both once in the AWS console (free).
          </span>
        </div>
      </div>
    </>
  );
}

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 22px', display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'center' }}>
      <div style={{ maxWidth: 560 }}>
        <b style={{ fontWeight: 600 }}>{title}</b>
        {desc && (
          <div className="ink2" style={{ fontSize: 13 }}>
            {desc}
          </div>
        )}
      </div>
      <div style={{ flex: 'none' }}>{children}</div>
    </div>
  );
}

function Toggle({ on, set }: { on: boolean; set(v: boolean): void }) {
  return (
    <div className="seg">
      <button className={on ? 'on' : ''} onClick={() => set(true)}>
        On
      </button>
      <button className={!on ? 'on' : ''} onClick={() => set(false)}>
        Off
      </button>
    </div>
  );
}

/** Self-checks on the numbers, and what to compare against the AWS console */
function DataCheck() {
  const s = useStore();
  const snap = s.snapshot!;
  const rec = useMemo(() => reconcile(snap), [snap]);
  const [copied, setCopied] = useState(false);
  const failed = rec.checks.filter((c) => c.status === 'fail').length;
  const ICON = { pass: 'check', warn: 'alert', fail: 'alert', info: 'info' } as const;
  const TONE = { pass: 'var(--good-ink)', warn: 'var(--warn-ink)', fail: 'var(--crit-ink)', info: 'var(--muted)' } as const;
  return (
    <>
      <div className="section-h">
        <h2>Can I trust these numbers?</h2>
        <p>{failed ? `${failed} check${failed === 1 ? '' : 's'} failed` : 'Self-checks run on every scan'}</p>
      </div>
      <div className="card rows">
        {rec.checks.map((c) => (
          <div key={c.id} style={{ padding: '12px 22px', display: 'grid', gridTemplateColumns: '22px 1fr', gap: 12, fontSize: 13 }}>
            <span style={{ color: TONE[c.status], marginTop: 1 }}>
              <Icon name={ICON[c.status]} size={17} />
            </span>
            <div>
              <b style={{ fontWeight: 600 }}>{c.label}</b>
              <div className="ink2">{c.detail}</div>
            </div>
          </div>
        ))}
        <div style={{ padding: '14px 22px' }}>
          <b style={{ fontWeight: 600 }}>Compare with the AWS console</b>
          <div className="ink2" style={{ fontSize: 13 }}>
            These should match Cost Explorer for the same dates, with cost type "{snap.meta.costBasis.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}" and charge types Credit and Refund excluded.
          </div>
          <div style={{ display: 'flex', gap: 32, margin: '10px 0 12px', flexWrap: 'wrap' }}>
            {rec.compare.map((c) => (
              <div key={c.label}>
                <div className="muted" style={{ fontSize: 12 }}>
                  {c.label}
                </div>
                <div className="num" style={{ fontSize: 20, fontWeight: 630, letterSpacing: '-0.02em', userSelect: 'text' }}>
                  {money(c.value, { cents: true })}
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {snap.meta.mode === 'live' && (
              <button className="btn sm" onClick={() => openExternal(rec.consoleUrl)}>
                <Icon name="ext" size={13} /> Open the same view in Cost Explorer
              </button>
            )}
            <button
              className="btn sm ghost"
              title="Totals, counts and check results. No resource names, account ids or credentials."
              onClick={() => {
                void navigator.clipboard.writeText(diagnostics(snap));
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              }}
            >
              <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy diagnostics for a bug report'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function MemberRole() {
  const s = useStore();
  const snap = s.snapshot;
  const [name, setName] = useState(s.settings.memberRoleName);
  useEffect(() => setName(s.settings.memberRoleName), [s.settings.memberRoleName]);
  const dirty = name.trim() !== s.settings.memberRoleName;
  const valid = /^[\w+=,.@-]{0,64}$/.test(name.trim());
  const accounts = snap?.accounts.length ?? 0;
  const scanned = snap?.meta.accountsScanned?.length;
  return (
    <div style={{ padding: '14px 22px' }}>
      <b style={{ fontWeight: 600 }}>Member-account role</b>
      <div className="ink2" style={{ fontSize: 13, maxWidth: 640 }}>
        The resource scan can only see inside accounts it can enter. Create the same read-only role in each member account, enter its name here, and CloudPennies will assume it to find unused dashboards, forgotten log groups and idle disks across the whole organization.
        {snap?.meta.mode === 'live' && accounts > 1 && (
          <>
            {' '}
            <b style={{ color: 'var(--ink)' }}>
              Last scan inspected {scanned ?? 1} of {accounts} accounts.
            </b>
          </>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="CloudPenniesReadOnly" spellCheck={false} style={{ maxWidth: 280 }} />
        <button className="btn sm primary" disabled={!dirty || !valid} onClick={() => void s.saveSettings({ ...s.settings, memberRoleName: name.trim() })}>
          Save
        </button>
        <button className="btn sm ghost" onClick={() => openExternal('https://github.com/dominicplouffe/CloudPennies/blob/main/docs/MEMBER_ROLE.md')}>
          <Icon name="ext" size={13} /> How to create the role
        </button>
      </div>
      {!valid && <div className="note err" style={{ marginTop: 8 }}>That is not a valid IAM role name.</div>}
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        Leave empty to scan only the connected account. Takes effect on the next scan.
      </div>
    </div>
  );
}

function Slack() {
  const s = useStore();
  const [has, setHas] = useState(false);
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    bridge?.hasSlackWebhook?.().then(setHas).catch(() => undefined);
  }, []);
  const save = async (value: string | null) => {
    if (!bridge) return;
    setBusy(true);
    const r = await bridge.setSlackWebhook(value);
    setBusy(false);
    if (r.ok) {
      setHas(value !== null);
      setUrl('');
      setMsg({ ok: true, text: value ? 'Saved. The address is stored encrypted on this computer.' : 'Removed.' });
    } else setMsg({ ok: false, text: r.error });
  };
  const test = async () => {
    if (!bridge) return;
    setBusy(true);
    const err = await bridge.testNotifications();
    setBusy(false);
    setMsg(err ? { ok: false, text: err } : { ok: true, text: has ? 'Sent a test notification and a test Slack message.' : 'Sent a test notification.' });
  };
  return (
    <div style={{ padding: '14px 22px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'center' }}>
        <div style={{ maxWidth: 560 }}>
          <b style={{ fontWeight: 600 }}>Slack</b>
          <div className="ink2" style={{ fontSize: 13 }}>
            Post alerts to a channel through a Slack incoming webhook. This is the only thing CloudPennies ever sends anywhere other than AWS, and only if you set it up: alert titles and dollar amounts, never credentials.
          </div>
        </div>
        <div style={{ flex: 'none' }}>
          <span className={`badge ${has ? 'good' : ''}`}>{has ? 'Connected' : 'Not set up'}</span>
        </div>
      </div>
      {!bridge ? (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
          Available in the desktop app.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {!has && <input type="password" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" autoComplete="off" style={{ maxWidth: 360 }} />}
            {!has ? (
              <button className="btn sm primary" disabled={busy || url.trim().length < 20} onClick={() => void save(url.trim())}>
                Save
              </button>
            ) : (
              <button className="btn sm" disabled={busy} onClick={() => void save(null)}>
                Remove webhook
              </button>
            )}
            <button className="btn sm" disabled={busy} onClick={() => void test()}>
              Send a test
            </button>
            {has && (
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, marginLeft: 6 }}>
                <input type="checkbox" checked={s.settings.weeklyDigest} onChange={(e) => void s.saveSettings({ ...s.settings, weeklyDigest: e.target.checked })} />
                Weekly digest every Monday
              </label>
            )}
          </div>
          {msg && (
            <div className={`note ${msg.ok ? '' : 'err'}`} style={{ marginTop: 8 }}>
              <Icon name={msg.ok ? 'check' : 'alert'} size={15} />
              {msg.text}
            </div>
          )}
        </>
      )}
    </div>
  );
}
