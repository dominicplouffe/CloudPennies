import { useEffect, useState } from 'react';
import { iamPolicyJson } from '../../core/iamPolicy';
import { Icon } from '../bits';
import { bridge, useStore } from '../store';

export function Welcome() {
  const s = useStore();
  return (
    <div className="welcome">
      <div className="left">
        <img src="./logo.svg" alt="CloudPennies" width={72} height={72} />
        <h1>
          Every cloud dollar
          <br />
          has a <em>story</em>.
        </h1>
        <p className="page-sub" style={{ fontSize: 17 }}>
          CloudPennies reads your AWS bill and tells you, in plain language, where the money goes, what changed, and what to do about it.
        </p>
        <ul className="promise">
          <li>
            <Icon name="brief" />
            <span>
              <b>A briefing, not a dashboard.</b> The three things that moved your bill this month — and why.
            </span>
          </li>
          <li>
            <Icon name="anomaly" />
            <span>
              <b>Anomalies with a cause.</b> Spikes and silent step-ups traced to the exact line item.
            </span>
          </li>
          <li>
            <Icon name="savings" />
            <span>
              <b>Savings, ranked.</b> Idle resources, forgotten logs, unused dashboards, what to reserve today.
            </span>
          </li>
          <li>
            <Icon name="commit" />
            <span>
              <b>No renewal surprises.</b> Every Savings Plan and reservation on a calendar, with what lapses when.
            </span>
          </li>
        </ul>
      </div>
      <div className="right">
        <div style={{ maxWidth: 460, width: '100%', margin: '0 auto', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <ConnectForm />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '22px 0', color: 'var(--muted)', fontSize: 12 }}>
            <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            or
            <div style={{ flex: 1, height: 1, background: 'var(--line)' }} />
          </div>
          <button className="btn" style={{ width: '100%', justifyContent: 'center', padding: '10px' }} onClick={s.startDemo}>
            Explore with demo data <Icon name="arrow" size={15} />
          </button>
          <p className="muted" style={{ fontSize: 12, textAlign: 'center', marginTop: 8 }}>
            A realistic sample account. Nothing leaves your computer.
          </p>
        </div>
      </div>
    </div>
  );
}

export function ConnectForm({ compact }: { compact?: boolean }) {
  const s = useStore();
  const [mode, setMode] = useState<'keys' | 'profile'>('keys');
  const [profiles, setProfiles] = useState<string[]>([]);
  const [profile, setProfile] = useState('');
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showPolicy, setShowPolicy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [withScan, setWithScan] = useState(true);

  useEffect(() => {
    bridge
      ?.listProfiles()
      .then((p) => {
        setProfiles(p);
        if (p.length) setProfile(p[0]);
      })
      .catch(() => undefined);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const error = await s.connect(mode === 'keys' ? { kind: 'keys', accessKeyId: keyId.trim(), secretAccessKey: secret.trim(), sessionToken: token.trim() || undefined } : { kind: 'profile', profile });
    setBusy(false);
    if (error) setErr(error);
  };

  const policy = iamPolicyJson(withScan);
  const ready = mode === 'keys' ? keyId.trim().length >= 16 && secret.trim().length >= 20 : !!profile;

  return (
    <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
      {!compact && (
        <div>
          <h2 style={{ fontSize: 20, letterSpacing: '-0.01em' }}>Connect your AWS account</h2>
          <p className="ink2" style={{ marginTop: 4 }}>
            Use a read-only key with billing access. For an organization, use the management (payer) account to see everything.
          </p>
        </div>
      )}
      <div className="seg" style={{ justifySelf: 'start' }}>
        <button type="button" className={mode === 'keys' ? 'on' : ''} onClick={() => setMode('keys')}>
          Access key
        </button>
        <button type="button" className={mode === 'profile' ? 'on' : ''} onClick={() => setMode('profile')}>
          AWS profile
        </button>
      </div>
      {mode === 'keys' ? (
        <>
          <label className="field">
            Access key ID
            <input type="text" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="AKIA…" autoComplete="off" spellCheck={false} />
          </label>
          <label className="field">
            Secret access key
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
          </label>
          <label className="field">
            Session token <span className="muted">(only for temporary credentials)</span>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
          </label>
        </>
      ) : (
        <label className="field">
          Profile from ~/.aws
          <select value={profile} onChange={(e) => setProfile(e.target.value)} disabled={!profiles.length}>
            {profiles.length ? profiles.map((p) => <option key={p}>{p}</option>) : <option>No profiles found</option>}
          </select>
        </label>
      )}
      {err && (
        <div className="note err">
          <Icon name="alert" size={16} />
          <span>{err}</span>
        </div>
      )}
      {!bridge && (
        <div className="note warn">
          <Icon name="info" size={16} />
          <span>You are viewing CloudPennies in a browser. Connecting to AWS needs the desktop app — the demo works everywhere.</span>
        </div>
      )}
      <button className="btn primary" style={{ justifyContent: 'center', padding: '10px' }} disabled={!ready || busy || !bridge}>
        {busy ? 'Checking credentials…' : 'Connect and scan'}
      </button>
      <div className="note">
        <Icon name="lock" size={16} />
        <span>
          Your key is encrypted with your operating system's keychain and never leaves this computer. CloudPennies talks only to AWS, makes read-only calls, and has no server of its own.{' '}
          <button type="button" className="link" onClick={() => setShowPolicy(!showPolicy)}>
            {showPolicy ? 'Hide' : 'Show'} the exact IAM policy
          </button>
        </span>
      </div>
      {showPolicy && (
        <div style={{ display: 'grid', gap: 8 }}>
          <label style={{ display: 'flex', gap: 8, fontSize: 12.5, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={withScan} onChange={(e) => setWithScan(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              Include the optional resource scan (finds unused dashboards, forgotten log groups, unattached disks). Billing analysis works without it.
            </span>
          </label>
          <pre className="policy">{policy}</pre>
          <button
            type="button"
            className="btn sm"
            style={{ justifySelf: 'start' }}
            onClick={() => {
              void navigator.clipboard.writeText(policy);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? 'Copied' : 'Copy policy'}
          </button>
          <p className="muted" style={{ fontSize: 12 }}>
            Cost Explorer must be enabled on the account (Billing → Cost Explorer). AWS charges $0.01 per Cost Explorer API request; a full scan is typically $0.30–$0.80, and results are cached.
          </p>
        </div>
      )}
    </form>
  );
}
