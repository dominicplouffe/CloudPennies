import { useEffect, useMemo, useState } from 'react';
import { iamPolicyJson } from '../../core/iamPolicy';
import { diagnostics, reconcile } from '../../core/reconcile';
import type { CurStatus, Settings } from '../../core/types';
import { fmtDateLong, money, monthName } from '../../core/util';
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
  const policy = iamPolicyJson(true, s.settings.memberRoleName || undefined, s.settings.curEnabled ? 'YOUR-REPORT-BUCKET' : undefined);

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

      <CurSection />

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

      <About />

      <div className="section-h">
        <h2>IAM policy</h2>
        <p>Read-only. Only the first statement is required. Replace YOUR-REPORT-BUCKET with the bucket shown above.</p>
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

/** Cost and Usage Report: resource-level cost with history */
function CurSection() {
  const s = useStore();
  const snap = s.snapshot;
  const [st, setSt] = useState<CurStatus | null>(null);
  const [busy, setBusy] = useState<'' | 'list' | 'import'>('');
  const [err, setErr] = useState<string | null>(null);
  const live = !!bridge && s.connection.connected;

  const load = (refresh: boolean) => {
    if (!bridge?.getCurStatus) return;
    setBusy('list');
    bridge
      .getCurStatus(refresh)
      .then(setSt)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(''));
  };
  useEffect(() => {
    if (live) load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, snap?.meta.generatedAt]);

  const runImport = async () => {
    if (!bridge) return;
    setBusy('import');
    setErr(null);
    const r = await bridge.importCur();
    setBusy('');
    if (r.ok) setSt(r.status);
    else setErr(r.error);
  };

  const months = live ? (st?.months ?? []) : (snap?.meta.cur?.months ?? []);
  const exports = st?.exports ?? [];
  const selected = exports.find((e) => e.id === st?.selected);
  const usable = exports.filter((e) => e.usable);

  return (
    <>
      <div className="section-h">
        <h2>Cost and Usage Report</h2>
        <p>Which exact resource every dollar went to, for whole months</p>
      </div>
      <div className="card rows">
        <Row
          title="Import the report during scans"
          desc="Cost Explorer only keeps cost per resource for 14 days. The Cost and Usage Report, which AWS delivers to an S3 bucket you own, has it for every month. CloudPennies downloads it, keeps a compact summary on this computer, and uses it for the Resource view in Explore."
        >
          <Toggle on={s.settings.curEnabled} set={(v) => void s.saveSettings({ ...s.settings, curEnabled: v })} />
        </Row>
        <div style={{ padding: '14px 22px' }}>
          {!live ? (
            <div className="ink2" style={{ fontSize: 13 }}>
              {snap?.meta.mode === 'demo'
                ? `The demo account has ${months.length} months imported from an export called "${snap.meta.cur?.exportName}". Connect an AWS account to use your own.`
                : 'Connect an AWS account to look for report exports.'}
            </div>
          ) : !st ? (
            <div className="ink2" style={{ fontSize: 13 }}>
              Looking for exports…
            </div>
          ) : (
            <>
              {exports.length === 0 ? (
                <div className="note">
                  <Icon name="info" size={16} />
                  <span>
                    {st.lastError ?? 'No Cost and Usage Report export was found on this account.'}{' '}
                    {st.missingPermission && (
                      <>
                        Missing permission: <code>{st.missingPermission}</code>.{' '}
                      </>
                    )}
                    <button className="link" onClick={() => openExternal('https://github.com/dominicplouffe/CloudPennies/blob/main/docs/CUR.md')}>
                      How to create one
                    </button>
                  </span>
                </div>
              ) : (
                <>
                  <label className="field" style={{ maxWidth: 520 }}>
                    Export to read
                    <select value={s.settings.curExportId} onChange={(e) => void s.saveSettings({ ...s.settings, curExportId: e.target.value })}>
                      <option value="">Choose automatically{selected ? ` (${selected.name})` : ''}</option>
                      {exports.map((e) => (
                        <option key={e.id} value={e.id} disabled={!e.usable}>
                          {e.name} — {e.kind === 'cur2' ? 'Data Export' : 'legacy report'}, {e.format}
                          {e.usable ? '' : ' (not usable)'}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selected && (
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
                      s3://{selected.bucket}/{selected.prefix} · {selected.region} · {selected.granularity.toLowerCase()}
                    </div>
                  )}
                  {usable.length === 0 && (
                    <div className="note warn" style={{ marginTop: 10 }}>
                      <Icon name="alert" size={16} />
                      <span>
                        None of the {exports.length} export{exports.length === 1 ? '' : 's'} can be used: {exports[0].reason ?? 'unsupported configuration'}{' '}
                        <button className="link" onClick={() => openExternal('https://github.com/dominicplouffe/CloudPennies/blob/main/docs/CUR.md')}>
                          What is needed
                        </button>
                      </span>
                    </div>
                  )}
                  {st.lastError && (
                    <div className="note err" style={{ marginTop: 10 }}>
                      <Icon name="alert" size={16} />
                      <span>
                        {st.lastError}
                        {st.missingPermission && (
                          <>
                            {' '}
                            Missing permission: <code>{st.missingPermission}</code>.
                          </>
                        )}
                      </span>
                    </div>
                  )}
                </>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn sm primary" disabled={!!busy || !!s.scanning || usable.length === 0} onClick={() => void runImport()}>
                  <Icon name="download" size={13} /> {busy === 'import' ? 'Importing…' : months.length ? 'Update now' : 'Import now'}
                </button>
                <button className="btn sm" disabled={!!busy} onClick={() => load(true)}>
                  <Icon name="refresh" size={13} /> Look again
                </button>
                <span className="muted" style={{ fontSize: 12.5, marginLeft: 6 }}>
                  Keep
                </span>
                <div className="seg">
                  {([1, 3, 6, 12] as const).map((v) => (
                    <button key={v} className={s.settings.curMonths === v ? 'on' : ''} onClick={() => void s.saveSettings({ ...s.settings, curMonths: v })}>
                      {v} mo
                    </button>
                  ))}
                </div>
              </div>
              {err && (
                <div className="note err" style={{ marginTop: 10 }}>
                  <Icon name="alert" size={16} />
                  {err}
                </div>
              )}
            </>
          )}
          {months.length > 0 && (
            <table className="tbl" style={{ marginTop: 14 }}>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 0 }}>Month</th>
                  <th className="r">Report total</th>
                  <th className="r">Rows kept</th>
                  <th className="r" style={{ paddingRight: 0 }}>
                    Imported
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...months]
                  .sort((a, b) => b.month.localeCompare(a.month))
                  .map((m) => (
                    <tr key={m.month}>
                      <td style={{ paddingLeft: 0 }}>
                        {monthName(m.month + '-01')} {m.month.slice(0, 4)} {!m.complete && <span className="badge" style={{ marginLeft: 6 }}>in progress</span>}
                      </td>
                      <td className="r">{money(m.cost)}</td>
                      <td className="r">{m.rows.toLocaleString()}</td>
                      <td className="r ink2" style={{ paddingRight: 0 }}>
                        {fmtDateLong(m.ingestedAt)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

/** Version and updates */
function About() {
  const s = useStore();
  const info = s.appInfo;
  const u = s.update;
  if (!info) return null;
  const text =
    u.state === 'checking'
      ? 'Checking for a newer version…'
      : u.state === 'up-to-date'
        ? 'You have the latest version.'
        : u.state === 'downloading'
          ? `Downloading version ${u.version ?? ''}${u.percent !== undefined ? ` — ${Math.round(u.percent)}%` : ''}…`
          : u.state === 'ready'
            ? `Version ${u.version ?? ''} is downloaded and will be installed when you restart.`
            : u.state === 'available'
              ? `Version ${u.version ?? ''} is available, but this copy cannot install it by itself${u.message ? ` (${u.message})` : ''}.`
              : u.state === 'unsupported'
                ? (u.message ?? 'This copy is running from source and does not update itself.')
                : u.state === 'error'
                  ? `Could not check for updates: ${u.message ?? 'unknown error'}`
                  : info.packaged
                    ? 'CloudPennies checks GitHub Releases for new versions.'
                    : 'This copy is running from source and does not update itself.';
  return (
    <>
      <div className="section-h">
        <h2>About</h2>
        <p>
          CloudPennies {info.version} · {info.platform}
        </p>
      </div>
      <div className="card rows">
        <Row title="Update automatically" desc="Download new versions in the background and install them the next time you restart. The only thing sent is a request to GitHub for the latest release.">
          <Toggle on={s.settings.autoUpdate} set={(v) => void s.saveSettings({ ...s.settings, autoUpdate: v })} />
        </Row>
        <div style={{ padding: '14px 22px', display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'center' }}>
          <div className={u.state === 'error' ? '' : 'ink2'} style={{ fontSize: 13, color: u.state === 'error' ? 'var(--crit-ink)' : undefined }}>
            {text}
          </div>
          <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
            {u.state === 'ready' && (
              <button className="btn sm primary" onClick={() => void bridge?.installUpdate()}>
                Restart to update
              </button>
            )}
            {u.state === 'available' && (
              <button className="btn sm primary" onClick={() => openExternal(u.releaseUrl ?? 'https://github.com/dominicplouffe/CloudPennies/releases/latest')}>
                <Icon name="ext" size={13} /> Download
              </button>
            )}
            <button className="btn sm" disabled={u.state === 'checking' || u.state === 'downloading'} onClick={() => void s.checkForUpdates()}>
              Check now
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
