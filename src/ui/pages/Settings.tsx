import { useState } from 'react';
import { iamPolicyJson } from '../../core/iamPolicy';
import type { Settings } from '../../core/types';
import { money } from '../../core/util';
import { Icon, PageHead } from '../bits';
import { useStore } from '../store';
import { ConnectForm } from './Welcome';

export function SettingsPage() {
  const s = useStore();
  const snap = s.snapshot;
  const set = (patch: Partial<Settings>) => void s.saveSettings({ ...s.settings, ...patch });
  const [copied, setCopied] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const live = snap?.meta.mode === 'live' || s.connection.connected;

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
        <p>Read-only. The second statement is only needed for the resource scan.</p>
      </div>
      <div className="card pad" style={{ display: 'grid', gap: 10 }}>
        <pre className="policy" style={{ maxHeight: 280 }}>
          {iamPolicyJson(true)}
        </pre>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            className="btn sm"
            onClick={() => {
              void navigator.clipboard.writeText(iamPolicyJson(true));
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
