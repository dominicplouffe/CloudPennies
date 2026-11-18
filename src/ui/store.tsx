import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { analyze } from '../core/analysis';
import { demoHistory, demoSnapshot, demoSource } from '../core/demo';
import { progress as computeProgress, type Progress } from '../core/history';
import type { Bridge, ConnectionInfo, CredentialInput, DataSource, Dim, HistoryEntry, Report, ScanProgress, Settings, Snapshot, Thread } from '../core/types';
import { DEFAULT_SETTINGS } from '../core/types';

export const bridge: Bridge | undefined = (window as unknown as { cloudpennies?: Bridge }).cloudpennies;

export type Page = 'briefing' | 'explore' | 'anomalies' | 'savings' | 'commitments' | 'settings';
export type Period = '30d' | '90d' | 'mtd' | 'last-month' | '12m';

export interface ExploreState {
  filters: Partial<Record<Dim, string[]>>;
  groupBy: Dim;
  period: Period;
}

interface Store {
  phase: 'loading' | 'welcome' | 'ready';
  snapshot: Snapshot | null;
  report: Report | null;
  /** what has been achieved since the first scan; null until history is loaded */
  progress: Progress | null;
  settings: Settings;
  connection: ConnectionInfo;
  source: DataSource;
  scanning: ScanProgress | null;
  scanError: string | null;
  page: Page;
  setPage(p: Page): void;
  /** id of an insight/anomaly to scroll to and open on the target page */
  focusId: string | null;
  go(p: Page, focusId?: string): void;
  explore: ExploreState;
  setExplore(e: ExploreState): void;
  pullThread(t: Thread): void;
  dismissed: Set<string>;
  toggleDismissed(id: string): void;
  startDemo(): void;
  connect(input: CredentialInput): Promise<string | null>;
  rescan(): Promise<void>;
  disconnect(): Promise<void>;
  saveSettings(s: Settings): Promise<void>;
}

const Ctx = createContext<Store>(null as unknown as Store);
export const useStore = () => useContext(Ctx);

const lsGet = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

const DEFAULT_EXPLORE: ExploreState = { filters: {}, groupBy: 'SERVICE', period: '30d' };

export function StoreProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Store['phase']>('loading');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState<Settings>(() => ({ ...DEFAULT_SETTINGS, ...lsGet<Partial<Settings>>('cp.settings', {}) }));
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [connection, setConnection] = useState<ConnectionInfo>({ connected: false });
  const [scanning, setScanning] = useState<ScanProgress | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [page, setPageRaw] = useState<Page>('briefing');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [explore, setExplore] = useState<ExploreState>(DEFAULT_EXPLORE);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set(lsGet<string[]>('cp.dismissed', [])));
  const scanLock = useRef(false);

  const report = useMemo(() => (snapshot ? analyze(snapshot, settings) : null), [snapshot, settings]);

  // scan history: from disk for a live account, synthesized for the demo
  useEffect(() => {
    if (!snapshot) return setHistory([]);
    if (snapshot.meta.mode === 'live' && bridge) {
      let dead = false;
      bridge
        .getHistory()
        .then((h) => !dead && setHistory(h))
        .catch(() => !dead && setHistory([]));
      return () => {
        dead = true;
      };
    }
    setHistory(demoHistory(snapshot.meta.today, analyze(snapshot, DEFAULT_SETTINGS)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  const progress = useMemo(() => (report ? computeProgress(history, report) : null), [history, report]);

  // a scheduled scan in the main process replaced the snapshot
  useEffect(() => {
    if (!bridge?.onSnapshotUpdated) return;
    return bridge.onSnapshotUpdated((snap) => {
      setSnapshot(snap);
      setPhase('ready');
    });
  }, []);

  const source = useMemo<DataSource>(() => {
    if (snapshot?.meta.mode === 'live' && bridge) return { query: (q) => bridge.query(q) };
    return demoSource(snapshot?.meta.today);
  }, [snapshot]);

  const rescan = useCallback(async () => {
    if (!bridge || scanLock.current) return;
    scanLock.current = true;
    setScanError(null);
    setScanning({ step: 'Connecting to AWS', done: 0, total: 1 });
    const off = bridge.onScanProgress(setScanning);
    try {
      const res = await bridge.scan();
      if (res.ok) {
        setSnapshot(res.snapshot);
        setPhase('ready');
      } else setScanError(res.error);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e));
    } finally {
      off();
      setScanning(null);
      scanLock.current = false;
    }
  }, []);

  // boot
  useEffect(() => {
    (async () => {
      if (!bridge) return setPhase('welcome');
      try {
        const [s, c] = await Promise.all([bridge.getSettings(), bridge.getConnection()]);
        setSettings({ ...DEFAULT_SETTINGS, ...s });
        setConnection(c);
        if (!c.connected) return setPhase('welcome');
        const snap = await bridge.loadSnapshot();
        if (snap) {
          setSnapshot(snap);
          setPhase('ready');
          if (Date.now() - new Date(snap.meta.generatedAt).getTime() > 12 * 3600_000) void rescan();
        } else {
          setPhase('ready');
          void rescan();
        }
      } catch {
        setPhase('welcome');
      }
    })();
  }, [rescan]);

  // theme
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && mq.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.theme]);

  const setPage = useCallback((p: Page) => {
    setFocusId(null);
    setPageRaw(p);
    document.querySelector('.main')?.scrollTo({ top: 0 });
  }, []);

  const store: Store = {
    phase,
    snapshot,
    report,
    progress,
    settings,
    connection,
    source,
    scanning,
    scanError,
    page,
    setPage,
    focusId,
    go(p, id) {
      setFocusId(id ?? null);
      setPageRaw(p);
      if (!id) document.querySelector('.main')?.scrollTo({ top: 0 });
    },
    explore,
    setExplore,
    pullThread(t) {
      setExplore({ filters: t.filters, groupBy: t.groupBy, period: explore.period });
      setPage('explore');
    },
    dismissed,
    toggleDismissed(id) {
      const next = new Set(dismissed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setDismissed(next);
      lsSet('cp.dismissed', [...next]);
    },
    startDemo() {
      setSnapshot(demoSnapshot());
      setExplore(DEFAULT_EXPLORE);
      setPageRaw('briefing');
      setPhase('ready');
    },
    async connect(input) {
      if (!bridge) return 'Connecting to AWS is only available in the desktop app.';
      const res = await bridge.connect(input);
      if (!res.ok) return res.error;
      setConnection(res.info);
      setSnapshot(null);
      setExplore(DEFAULT_EXPLORE);
      setPageRaw('briefing');
      setPhase('ready');
      void rescan();
      return null;
    },
    rescan,
    async disconnect() {
      if (bridge && connection.connected) await bridge.disconnect();
      setConnection({ connected: false });
      setSnapshot(null);
      setScanError(null);
      setPhase('welcome');
    },
    async saveSettings(s) {
      setSettings(s);
      lsSet('cp.settings', s);
      if (bridge) await bridge.saveSettings(s);
    },
  };

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export async function saveTextFile(name: string, content: string) {
  if (bridge) return void (await bridge.saveFile(name, content));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function openExternal(url: string) {
  if (bridge) void bridge.openExternal(url);
  else window.open(url, '_blank', 'noopener');
}
