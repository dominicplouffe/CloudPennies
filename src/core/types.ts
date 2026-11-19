/**
 * CloudPennies shared data model.
 *
 * Flow:  DataSource (live AWS or demo)  ->  Snapshot (raw, normalized facts)
 *        Snapshot  ->  analyze()  ->  Report (insights, anomalies, briefing)
 *
 * Everything in this file is plain JSON-serializable data so it can cross the
 * Electron IPC boundary and be cached on disk.
 */

// ───────────────────────────── Cost queries ─────────────────────────────

/**
 * A grouping / filter dimension. Plain Cost Explorer dimension names, or
 * `TAG:<key>` for a cost allocation tag.
 */
export type Dim =
  | 'SERVICE'
  | 'USAGE_TYPE'
  | 'REGION'
  | 'LINKED_ACCOUNT'
  | 'OPERATION'
  | 'PURCHASE_TYPE'
  | 'INSTANCE_TYPE'
  | 'RECORD_TYPE'
  /** individual resource (ARN or id). Live data needs resource-level data enabled in Cost Explorer and only covers the last 14 days. */
  | 'RESOURCE_ID'
  | `TAG:${string}`;

export type CostBasis = 'UnblendedCost' | 'NetUnblendedCost' | 'AmortizedCost' | 'NetAmortizedCost';

export interface CostQuery {
  /** inclusive ISO date (YYYY-MM-DD) */
  start: string;
  /** exclusive ISO date (YYYY-MM-DD) */
  end: string;
  granularity: 'DAILY' | 'MONTHLY';
  /** 0, 1 or 2 dimensions (Cost Explorer limit is 2) */
  groupBy: Dim[];
  /** dimension -> allowed values (AND across dimensions, OR within one). For tags, '' means untagged. */
  filters?: Partial<Record<Dim, string[]>>;
}

export interface CostRow {
  /** one value per groupBy dimension, same order. For LINKED_ACCOUNT this is the account id. Untagged = '' */
  keys: string[];
  /** period start, ISO date */
  date: string;
  cost: number;
  /** usage quantity, only meaningful when grouped by USAGE_TYPE */
  usage?: number;
}

export interface CostResult {
  rows: CostRow[];
}

// ───────────────────────────── Snapshot ─────────────────────────────

export interface ScanWarning {
  /** short machine id of the section that failed, e.g. 'budgets', 'cost-optimization-hub' */
  section: string;
  /** human explanation, e.g. "Access denied: budgets:ViewBudget" or "Cost Optimization Hub is not enabled" */
  message: string;
  /** IAM action(s) that would fix it, if it is a permission problem */
  missingPermission?: string;
}

export interface SnapshotMeta {
  mode: 'demo' | 'live';
  generatedAt: string; // ISO datetime
  /** the "today" the data is relative to (ISO date). Cost data is complete through the day before `dataThrough`... see below */
  today: string;
  /** last ISO date with (mostly) complete cost data; usually today-1 or today-2 */
  dataThrough: string;
  accountId: string;
  accountLabel: string;
  identityArn?: string;
  currency: string;
  costBasis: CostBasis;
  /** number of paid Cost Explorer API requests this scan made ($0.01 each) */
  ceRequests: number;
  /** whether the optional resource-level scan ran */
  deepScan: boolean;
  /** regions inspected by the resource-level scan */
  regionsScanned: string[];
  /** resource-level cost history imported from a Cost and Usage Report, if any */
  cur?: { exportName: string; months: CurMonth[] };
  /** account ids whose resources were inspected (the connected account plus member accounts reached by assuming a role) */
  accountsScanned?: string[];
  warnings: ScanWarning[];
}

export interface AccountInfo {
  id: string;
  name: string;
}

export interface Forecast {
  /** forecast for the remainder of the current month (from today to month end), not including month-to-date actuals */
  remaining: number;
  remainingLow?: number;
  remainingHigh?: number;
}

export interface Budget {
  name: string;
  limit: number;
  actual: number;
  forecast?: number;
  timeUnit: string; // MONTHLY, QUARTERLY, ANNUALLY...
  type: string; // COST, USAGE, ...
}

/** An anomaly reported by AWS Cost Anomaly Detection (if the account has monitors) */
export interface AwsAnomaly {
  id: string;
  start: string; // ISO date
  end?: string;
  service?: string;
  region?: string;
  account?: string;
  usageType?: string;
  impact: number; // total $ impact
  expected?: number;
  actual?: number;
  feedback?: string;
}

// ── Commitments ──

export interface SavingsPlan {
  id: string; // ARN or id
  /** 'Compute' | 'EC2Instance' | 'SageMaker' | 'Database' */
  type: string;
  region?: string;
  instanceFamily?: string;
  paymentOption: string; // 'No Upfront' | 'Partial Upfront' | 'All Upfront'
  termYears: number;
  hourlyCommitment: number;
  start: string; // ISO date
  end: string; // ISO date
  /** over the lookback window (last 30 days) */
  utilizationPct: number;
  usedCommitment: number;
  unusedCommitment: number;
  /** net savings vs on-demand over the lookback window */
  netSavings: number;
}

export interface Reservation {
  id: string;
  /** CE service name, e.g. 'Amazon Relational Database Service' */
  service: string;
  instanceType: string;
  region: string;
  count: number;
  /** platform / engine / description when known */
  platform?: string;
  offeringType?: string; // payment option
  termYears?: number;
  start?: string;
  end: string; // ISO date
  /** over the lookback window (last 30 days) */
  utilizationPct: number;
  unusedHours: number;
  /** amortized cost of the reservation over the lookback window */
  amortizedCost: number;
  /** $ of the amortized cost that went unused over the lookback window */
  unusedCost: number;
  /** net savings vs on-demand over the lookback window */
  netSavings: number;
}

export interface CoveragePoint {
  date: string;
  /** spend covered by Savings Plans or RIs, valued at on-demand rates */
  covered: number;
  /** eligible spend still paying on-demand rates */
  onDemand: number;
}

export interface ServiceCoverage {
  service: string;
  /** percent of eligible usage covered by commitments (0-100) */
  coveragePct: number;
  /** on-demand cost of the uncovered usage over the lookback window (30 days) */
  onDemandCost: number;
  kind: 'SP' | 'RI';
}

export interface SavingsPlanRecommendation {
  /** 'Compute' | 'EC2Instance' | 'SageMaker' | 'Database' */
  type: string;
  termYears: 1 | 3;
  paymentOption: string;
  lookbackDays: number;
  hourlyCommitment: number;
  upfrontCost: number;
  estimatedMonthlySavings: number;
  estimatedSavingsPct: number;
  /** current on-demand spend per month that the plan would address */
  currentMonthlyOnDemand: number;
  estimatedUtilizationPct?: number;
}

export interface ReservationRecommendation {
  service: string;
  instanceType: string; // or family when size-flexible
  region: string;
  platform?: string;
  count: number;
  termYears: 1 | 3;
  paymentOption: string;
  lookbackDays: number;
  upfrontCost: number;
  recurringMonthlyCost: number;
  estimatedMonthlySavings: number;
  estimatedSavingsPct: number;
  breakEvenMonths?: number;
  account?: string;
}

export interface Commitments {
  savingsPlans: SavingsPlan[];
  reservations: Reservation[];
  /** daily, last ~90 days. Combined SP + RI coverage of eligible compute/database spend */
  coverage: CoveragePoint[];
  coverageByService: ServiceCoverage[];
  /** totals over the last 30 days */
  totals: {
    spCommitment: number; // total SP commitment $ in the window
    spUsed: number;
    riAmortized: number; // total RI amortized cost
    riUnused: number;
    netSavings: number; // SP + RI net savings vs on-demand
    /** on-demand equivalent of everything that was covered */
    onDemandEquivalentCovered: number;
    /** eligible spend not covered by any commitment */
    onDemandEligible: number;
  };
  spRecommendations: SavingsPlanRecommendation[];
  riRecommendations: ReservationRecommendation[];
}

// ── Recommendations from AWS ──

export interface RightsizingRec {
  resourceId: string;
  name?: string;
  account?: string;
  region?: string;
  currentType: string;
  action: 'TERMINATE' | 'MODIFY';
  targetType?: string;
  currentMonthlyCost: number;
  monthlySavings: number;
  maxCpuPct?: number;
}

/** A recommendation from AWS Cost Optimization Hub (which aggregates Compute Optimizer etc.) */
export interface HubRec {
  id: string;
  resourceId?: string;
  /** e.g. 'Ec2Instance', 'EbsVolume', 'LambdaFunction', 'RdsDbInstance', 'EcsService', 'Ec2AutoScalingGroup', 'ComputeSavingsPlans', ... */
  resourceType: string;
  /** e.g. 'Rightsize', 'Stop', 'Upgrade', 'MigrateToGraviton', 'Delete', 'PurchaseSavingsPlans', 'PurchaseReservedInstances', 'ScaleIn' */
  actionType: string;
  currentSummary?: string;
  recommendedSummary?: string;
  monthlySavings: number;
  savingsPct?: number;
  currentMonthlyCost?: number;
  effort?: string; // VeryLow | Low | Medium | High | VeryHigh
  restartNeeded?: boolean;
  rollbackPossible?: boolean;
  region?: string;
  account?: string;
}

// ── Optional resource-level scan ──

export interface LogGroupInfo {
  /** owning account id, when known */
  account?: string;
  name: string;
  region: string;
  storedBytes: number;
  /** null = never expire */
  retentionDays: number | null;
  /** 'STANDARD' | 'INFREQUENT_ACCESS' */
  logClass?: string;
  createdAt?: string;
}

export interface DashboardInfo {
  account?: string;
  name: string;
  region: string;
  lastModified?: string;
  /** ISO datetime of the most recent GetDashboard event in CloudTrail (90-day history); null = no view in the window; undefined = could not determine */
  lastViewed?: string | null;
}

export interface VolumeInfo {
  account?: string;
  id: string;
  region: string;
  sizeGb: number;
  type: string; // gp2, gp3, io1...
  attached: boolean;
  createdAt?: string;
  name?: string;
  iops?: number;
}

export interface AddressInfo {
  account?: string;
  ip: string;
  region: string;
  allocationId?: string;
  associated: boolean;
}

export interface LoadBalancerInfo {
  account?: string;
  name: string;
  arn: string;
  region: string;
  type: string; // application | network | gateway
  /** number of registered targets across all target groups; 0 = idle */
  targets: number;
  createdAt?: string;
}

export interface ResourceFindings {
  logGroups: LogGroupInfo[];
  dashboards: DashboardInfo[];
  alarms: { total: number; insufficientData: number; noActions: number };
  volumes: VolumeInfo[];
  /** snapshots older than a year: aggregate only */
  oldSnapshots: { count: number; totalGb: number };
  addresses: AddressInfo[];
  loadBalancers: LoadBalancerInfo[];
  stoppedInstances: { account?: string; id: string; region: string; type: string; name?: string; stoppedSince?: string; ebsGb: number }[];
}

export interface Snapshot {
  meta: SnapshotMeta;
  accounts: AccountInfo[];
  /** 13 months, MONTHLY, keys [SERVICE] */
  monthlyByService: CostRow[];
  /** last 90 days, DAILY, keys [SERVICE, USAGE_TYPE], with usage quantity */
  dailyByServiceUsage: CostRow[];
  /** last 90 days, DAILY, keys [LINKED_ACCOUNT] */
  dailyByAccount: CostRow[];
  /** last 90 days, DAILY, keys [REGION] */
  dailyByRegion: CostRow[];
  /** last 30 days, MONTHLY-bucketed totals, keys [SERVICE, REGION] (used to choose regions and root-cause) */
  recentByServiceRegion: CostRow[];
  /** last 3 months, MONTHLY, keys [RECORD_TYPE] (Usage, Tax, Credit, Refund, Support, ...) */
  monthlyByRecordType: CostRow[];
  /** active cost allocation tag keys */
  tagKeys: string[];
  /** last 30 days total cost per value of the primary tag key (keys [tagValue], '' = untagged). Empty if no tags. */
  primaryTag: { key: string; rows: CostRow[] } | null;
  forecast: Forecast | null;
  budgets: Budget[];
  awsAnomalies: AwsAnomaly[];
  commitments: Commitments;
  rightsizing: RightsizingRec[];
  hubRecommendations: HubRec[];
  resources: ResourceFindings | null;
}

// ───────────────────────────── Report (analysis output) ─────────────────────────────

export type InsightCategory =
  | 'commitments'
  | 'idle'
  | 'rightsizing'
  | 'storage'
  | 'network'
  | 'observability'
  | 'modernize'
  | 'governance';

export type Level = 'low' | 'medium' | 'high';

/** Where clicking "pull the thread" should take the user in Explore */
export interface Thread {
  label: string;
  filters: Partial<Record<Dim, string[]>>;
  groupBy: Dim;
}

export interface Evidence {
  label: string;
  value: string;
}

export interface Insight {
  id: string;
  category: InsightCategory;
  title: string;
  /** one or two plain sentences: what is happening and why it matters */
  summary: string;
  /** estimated monthly savings in $; 0 when it cannot be estimated */
  monthlySavings: number;
  /** how sure we are about the savings number */
  confidence: Level;
  effort: Level;
  risk: Level;
  service?: string;
  source: 'CloudPennies' | 'Cost Optimization Hub' | 'Cost Explorer' | 'Resource scan';
  evidence: Evidence[];
  /** how to act on it */
  steps: string[];
  thread?: Thread;
  /** individual resources behind this insight */
  resources?: { id: string; detail: string; monthlySavings?: number }[];
  /** true when the action is time-sensitive (expiring commitments, extended support...) */
  urgent?: boolean;
}

export interface AnomalyCause {
  dim: Dim;
  key: string;
  label: string;
  /** excess $ attributed to this cause */
  impact: number;
}

export interface Anomaly {
  id: string;
  /** spike = temporary jump; shift = stepped up and stayed up; new = a service that did not exist before */
  kind: 'spike' | 'shift' | 'new';
  service: string;
  title: string;
  /** plain-language explanation */
  summary: string;
  start: string;
  end: string;
  ongoing: boolean;
  /** total excess $ over the anomaly window (negative for drops) */
  impact: number;
  /** projected extra $/month if it continues (ongoing only) */
  monthlyRunRate: number;
  expectedDaily: number;
  actualDaily: number;
  severity: Level;
  causes: AnomalyCause[];
  /** daily series for the chart: last 60 days */
  series: { date: string; cost: number; expected: number }[];
  source: 'CloudPennies' | 'AWS';
  thread: Thread;
}

export interface Driver {
  service: string;
  current: number;
  previous: number;
  delta: number;
  /** plain-language explanation of which usage types moved */
  why: string;
  parts: { label: string; usageType: string; delta: number }[];
}

export interface Expiration {
  id: string;
  kind: 'Savings Plan' | 'Reserved Instance';
  label: string;
  detail: string;
  end: string;
  daysLeft: number;
  /** what the monthly bill goes up by if this lapses and usage continues on-demand */
  monthlyExposure: number;
  /** monthly commitment / amortized cost */
  monthlyCommitment: number;
  utilizationPct: number;
}

export interface Briefing {
  /** last day of cost data the analysis used (may be a day earlier than the snapshot's when that day was incomplete) */
  dataThrough: string;
  monthLabel: string;
  prevMonthLabel: string;
  mtd: number;
  /** same number of days of the previous month */
  prevMtd: number;
  /** the comparison the drivers are based on */
  compare: { label: string; prevLabel: string; current: number; previous: number };
  prevMonthTotal: number;
  /** projected month-end total */
  projected: number;
  projectedLow?: number;
  projectedHigh?: number;
  projectionSource: 'aws' | 'run-rate';
  /** projected - mtd: what is still expected between now and month end */
  projectedRemaining: number;
  /** set when AWS's forecast was discarded for disagreeing wildly with the recent daily run rate */
  forecastRejected?: { awsRemaining: number; runRateRemaining: number };
  dailyAvg7: number;
  dailyAvgPrev7: number;
  /** total of last 30 days */
  last30: number;
  headline: string;
  /** narrative paragraphs */
  story: string[];
  drivers: Driver[];
  decreases: Driver[];
  /** daily totals for last 90 days, excluding once-a-month lump charges (listed in monthlyCharges) so the trend is readable */
  dailyTotals: { date: string; cost: number }[];
  /** charges billed as a lump once a month (support plans, upfront fees...) */
  monthlyCharges: { label: string; amount: number }[];
  /** monthly totals, 13 months */
  monthlyTotals: { date: string; cost: number; partial?: boolean }[];
  topServices: { service: string; cost: number; prev: number; share: number }[];
  /** credits/refunds applied in the current month (negative numbers), if any */
  creditsThisMonth: number;
  taxThisMonth: number;
}

export interface CommitmentSummary {
  /** Effective Savings Rate: savings from commitments / on-demand equivalent of eligible spend (0-100) */
  esrPct: number;
  coveragePct: number;
  utilizationPct: number;
  monthlyNetSavings: number;
  monthlyOnDemandEligible: number;
  monthlyWaste: number;
  expirations: Expiration[];
}

export interface TagCoverage {
  key: string;
  untaggedCost: number;
  totalCost: number;
  untaggedPct: number;
  values: { value: string; cost: number }[];
}

export interface Report {
  briefing: Briefing;
  insights: Insight[];
  anomalies: Anomaly[];
  commitments: CommitmentSummary;
  tagCoverage: TagCoverage | null;
  /** sum of insight savings, de-duplicated */
  totalMonthlySavings: number;
  budgets: Budget[];
}

// ───────────────────────────── App bridge (Electron preload) ─────────────────────────────

export interface Settings {
  costBasis: CostBasis;
  /** run the optional resource-level scan (needs read-only describe permissions) */
  deepScan: boolean;
  /** ignore anomalies with less total impact than this ($) */
  anomalyMinImpact: number;
  theme: 'system' | 'light' | 'dark';
  /**
   * Name of a read-only IAM role that exists in every member account (e.g. "CloudPenniesReadOnly").
   * When set, the resource scan assumes arn:aws:iam::<member>:role/<name> in each linked account.
   * '' = only scan the connected account.
   */
  memberRoleName: string;
  /** rescan automatically while the app is running; 0 = never */
  autoScanHours: 0 | 6 | 12 | 24;
  /** show a desktop notification when a scan finds something new */
  notifications: boolean;
  /** keep running in the menu bar / system tray when the window is closed, so scheduled scans still happen */
  runInBackground: boolean;
  launchAtLogin: boolean;
  /** post a summary to Slack every Monday (needs a webhook, see Bridge.setSlackWebhook) */
  weeklyDigest: boolean;
  /** import the Cost and Usage Report during scans for resource-level cost history */
  curEnabled: boolean;
  /** id of the export to read (CurExport.id); '' = pick the best usable one automatically */
  curExportId: string;
  /** how many months of report data to keep locally, including the current month */
  curMonths: 1 | 3 | 6 | 12;
  /** check GitHub Releases for a newer version and install it automatically */
  autoUpdate: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  costBasis: 'UnblendedCost',
  deepScan: true,
  anomalyMinImpact: 25,
  theme: 'system',
  memberRoleName: '',
  autoScanHours: 24,
  notifications: true,
  runInBackground: false,
  launchAtLogin: false,
  weeklyDigest: false,
  curEnabled: true,
  curExportId: '',
  curMonths: 3,
  autoUpdate: true,
};

export type CredentialInput =
  | { kind: 'keys'; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { kind: 'profile'; profile: string };

export interface ConnectionInfo {
  connected: boolean;
  /** 'keys' | 'profile' */
  kind?: 'keys' | 'profile';
  /** masked access key id or profile name */
  label?: string;
  accountId?: string;
  arn?: string;
  /** whether secrets are stored with OS-level encryption */
  encrypted?: boolean;
}

export interface ScanProgress {
  step: string;
  done: number;
  total: number;
}

export interface Bridge {
  platform: string;
  getConnection(): Promise<ConnectionInfo>;
  listProfiles(): Promise<string[]>;
  /** validates with STS before saving */
  connect(input: CredentialInput): Promise<{ ok: true; info: ConnectionInfo } | { ok: false; error: string }>;
  disconnect(): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Settings): Promise<void>;
  /** last cached snapshot for the connected account, if any */
  loadSnapshot(): Promise<Snapshot | null>;
  scan(): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; error: string }>;
  onScanProgress(cb: (p: ScanProgress) => void): () => void;
  query(q: CostQuery): Promise<CostResult>;
  saveFile(defaultName: string, content: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  /** one entry per scan for the connected account, oldest first */
  getHistory(): Promise<HistoryEntry[]>;
  /** store (encrypted) or clear (null) a Slack incoming-webhook URL. The URL is never returned to the renderer. */
  setSlackWebhook(url: string | null): Promise<{ ok: true } | { ok: false; error: string }>;
  hasSlackWebhook(): Promise<boolean>;
  /** send a test desktop notification and, if a webhook is set, a test Slack message. Returns an error string on failure. */
  testNotifications(): Promise<string | null>;
  /** Cost and Usage Report exports found on the account and what has been imported. `refresh` re-lists exports from AWS. */
  getCurStatus(refresh?: boolean): Promise<CurStatus>;
  /** import (or update) report data now, outside a scan. Progress is reported through onScanProgress. */
  importCur(): Promise<{ ok: true; status: CurStatus } | { ok: false; error: string }>;
  getAppInfo(): Promise<AppInfo>;
  /** ask GitHub Releases whether a newer version exists (no-op outside a packaged build) */
  checkForUpdates(): Promise<UpdateStatus>;
  /** quit and install a downloaded update (only valid when state is 'ready') */
  installUpdate(): Promise<void>;
  onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
  /** fired when the user clicks a desktop notification: open this page (and item) */
  onNavigate(cb: (target: { page: Alert['page']; focusId?: string }) => void): () => void;
  /** fired after a background (scheduled) scan replaced the cached snapshot */
  onSnapshotUpdated(cb: (snapshot: Snapshot) => void): () => void;
}

// ───────────────────────────── Cost and Usage Report ─────────────────────────────

/** A Cost and Usage Report export definition found on the account */
export interface CurExport {
  /** stable id: export ARN (Data Exports / CUR 2.0) or `legacy:<report name>` */
  id: string;
  name: string;
  kind: 'cur2' | 'legacy';
  bucket: string;
  prefix: string;
  /** region of the S3 bucket */
  region: string;
  format: 'parquet' | 'csv';
  /** whether the export includes resource ids (without them it adds nothing over Cost Explorer) */
  hasResourceIds: boolean;
  /** HOURLY | DAILY | MONTHLY */
  granularity: string;
  /** false when CloudPennies cannot use it; `reason` says why in plain language */
  usable: boolean;
  reason?: string;
}

/** One imported billing month */
export interface CurMonth {
  /** YYYY-MM */
  month: string;
  /** aggregated rows stored locally */
  rows: number;
  /** total cost of the month in the snapshot's cost basis, credits and refunds excluded — comparable to Cost Explorer */
  cost: number;
  ingestedAt: string;
  /** false for the month still in progress */
  complete: boolean;
}

export interface CurStatus {
  exports: CurExport[];
  /** id of the export in use, or null when none is usable */
  selected: string | null;
  months: CurMonth[];
  /** why the last listing or import failed, in plain language */
  lastError?: string;
  missingPermission?: string;
}

// ───────────────────────────── App updates ─────────────────────────────

export interface AppInfo {
  version: string;
  /** false when running from source (npm run dev:app): updates are disabled */
  packaged: boolean;
  platform: string;
}

export interface UpdateStatus {
  /**
   * idle: nothing checked yet · checking · up-to-date · available: a newer version exists but cannot be
   * installed automatically (see releaseUrl) · downloading · ready: downloaded, restart to install ·
   * error · unsupported: this build cannot update itself (running from source)
   */
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  /** the newer version, when one was found */
  version?: string;
  /** download progress 0-100 */
  percent?: number;
  /** plain-language detail (error text, why it is unsupported) */
  message?: string;
  /** where to download the new version by hand */
  releaseUrl?: string;
}

// ───────────────────────────── History ─────────────────────────────

/** A compact record of one scan, kept forever (small) so progress can be tracked over time */
export interface HistoryEntry {
  /** ISO datetime of the scan */
  at: string;
  /** ISO date the scan considered "today" */
  today: string;
  last30: number;
  mtd: number;
  projected: number;
  /** open opportunities at the time: id -> estimated monthly savings */
  insights: Record<string, { title: string; savings: number; category: InsightCategory }>;
  /** anomalies seen: id -> */
  anomalies: Record<string, { title: string; ongoing: boolean; impact: number; start: string }>;
  /** commitments with days left */
  expirations: Record<string, { label: string; daysLeft: number; exposure: number }>;
  esrPct: number;
  coveragePct: number;
}

/** Something worth telling the user about after a scan */
export interface Alert {
  kind: 'anomaly' | 'expiry' | 'savings' | 'resolved';
  title: string;
  body: string;
  /** page to open when the notification is clicked */
  page: 'anomalies' | 'commitments' | 'savings' | 'briefing';
  focusId?: string;
}

/** What the UI needs from a data source, live or demo */
export interface DataSource {
  query(q: CostQuery): Promise<CostResult>;
}
