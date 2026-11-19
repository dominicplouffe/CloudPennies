// Discovery of Cost and Usage Report exports: Data Exports (CUR 2.0) and legacy report definitions.
import { BCMDataExportsClient, GetExportCommand, ListExportsCommand, type Export } from '@aws-sdk/client-bcm-data-exports';
import { CostAndUsageReportServiceClient, DescribeReportDefinitionsCommand, type ReportDefinition } from '@aws-sdk/client-cost-and-usage-report-service';
import type { CurExport } from '../../../src/core/types';
import { classifyError, isAccessDenied } from '../errors';
import type { Creds } from '../resources';
import { normalizePrefix } from './paths';

/** Both listing APIs only exist in us-east-1. */
const BILLING_REGION = 'us-east-1';
const MAX_PAGES = 20;
const MAX_EXPORTS = 50;

const CUR_TABLE = 'COST_AND_USAGE_REPORT';

const TABLE_LABELS: Record<string, string> = {
  FOCUS_1_0_AWS: 'FOCUS',
  FOCUS_1_2_AWS: 'FOCUS',
  COST_OPTIMIZATION_RECOMMENDATIONS: 'cost optimization recommendations',
  CARBON_EMISSIONS: 'carbon emissions',
};

const NO_RESOURCES_REASON =
  'This export does not include resource IDs, so it adds nothing over Cost Explorer. Create a new export with "Include resource IDs" switched on (see docs/CUR.md).';

/** Columns CloudPennies cannot work without. */
const REQUIRED_COLUMNS = ['line_item_usage_start_date', 'line_item_unblended_cost', 'line_item_line_item_type'];

/** Which table a Data Exports query reads: the table configuration key, else the FROM clause. */
export function exportTable(e: Pick<Export, 'DataQuery'>): string {
  const tables = Object.keys(e.DataQuery?.TableConfigurations ?? {});
  if (tables.length) return tables.includes(CUR_TABLE) ? CUR_TABLE : tables[0];
  const m = /\bfrom\s+["`]?([A-Za-z0-9_]+)/i.exec(e.DataQuery?.QueryStatement ?? '');
  return m ? m[1].toUpperCase() : '';
}

/** true when the SQL statement selects `column` (or everything). */
export function querySelects(statement: string | undefined, column: string): boolean {
  const sql = statement ?? '';
  const m = /\bselect\b([\s\S]*?)\bfrom\b/i.exec(sql);
  const list = m ? m[1] : sql;
  if (/(^|,)\s*\*\s*(,|$)/.test(list)) return true;
  return new RegExp(`(^|[^A-Za-z0-9_])${column}([^A-Za-z0-9_]|$)`, 'i').test(list);
}

/** Data Exports (CUR 2.0) definition -> CurExport. */
export function mapDataExport(e: Export): CurExport {
  const dest = e.DestinationConfigurations?.S3Destination;
  const out = dest?.S3OutputConfigurations;
  const table = exportTable(e);
  const cfg = e.DataQuery?.TableConfigurations?.[table] ?? {};
  const statement = e.DataQuery?.QueryStatement;
  const format: CurExport['format'] = out?.Format === 'PARQUET' ? 'parquet' : 'csv';
  const includeResources = String(cfg.INCLUDE_RESOURCES ?? '').toUpperCase() === 'TRUE';
  const hasResourceIds = table === CUR_TABLE && includeResources && querySelects(statement, 'line_item_resource_id');
  const name = e.Name ?? '';

  let reason: string | undefined;
  if (table !== CUR_TABLE) {
    reason = `This export contains ${TABLE_LABELS[table] ?? (table ? table.toLowerCase().replace(/_/g, ' ') : 'other')} data, not Cost and Usage Report line items.`;
  } else if (!dest?.S3Bucket) {
    reason = 'This export has no S3 destination.';
  } else if (!hasResourceIds) {
    reason = NO_RESOURCES_REASON;
  } else if (format === 'csv' && out?.Compression !== 'GZIP') {
    reason = `This export is delivered as ${out?.Compression ?? 'an unknown format'}; CloudPennies reads Parquet or gzip-compressed CSV.`;
  } else if (format === 'parquet' && out?.Compression && out.Compression !== 'PARQUET') {
    reason = `This export uses ${out.Compression} compression; CloudPennies reads Parquet or gzip-compressed CSV.`;
  } else {
    const missing = REQUIRED_COLUMNS.filter((c) => !querySelects(statement, c));
    if (missing.length) reason = `This export leaves out columns CloudPennies needs (${missing.join(', ')}).`;
  }

  return {
    id: e.ExportArn || `cur2:${name}`,
    name,
    kind: 'cur2',
    bucket: dest?.S3Bucket ?? '',
    prefix: normalizePrefix(dest?.S3Prefix),
    region: dest?.S3Region || BILLING_REGION,
    format,
    hasResourceIds,
    granularity: String(cfg.TIME_GRANULARITY ?? 'UNKNOWN').toUpperCase(),
    usable: !reason,
    ...(reason ? { reason } : {}),
  };
}

/** Legacy report definition -> CurExport. */
export function mapLegacyReport(r: ReportDefinition): CurExport {
  const name = r.ReportName ?? '';
  const format: CurExport['format'] = r.Format === 'Parquet' || r.Compression === 'Parquet' ? 'parquet' : 'csv';
  const hasResourceIds = (r.AdditionalSchemaElements ?? []).includes('RESOURCES');
  let reason: string | undefined;
  if (!r.S3Bucket) reason = 'This report has no S3 destination.';
  else if (!hasResourceIds) reason = NO_RESOURCES_REASON;
  else if (format === 'csv' && r.Compression !== 'GZIP') {
    reason = `This report is delivered as ${r.Compression ?? 'an unknown format'}; CloudPennies reads Parquet or gzip-compressed CSV.`;
  }
  return {
    id: `legacy:${name}`,
    name,
    kind: 'legacy',
    bucket: r.S3Bucket ?? '',
    prefix: normalizePrefix(r.S3Prefix),
    region: r.S3Region || BILLING_REGION,
    format,
    hasResourceIds,
    granularity: r.TimeUnit ?? 'UNKNOWN',
    usable: !reason,
    ...(reason ? { reason } : {}),
  };
}

/** Best first: usable, CUR 2.0 over legacy, Parquet over CSV, then by name for a stable order. */
export function rankExports(exports: CurExport[]): CurExport[] {
  const score = (e: CurExport) => (e.usable ? 0 : 4) + (e.kind === 'cur2' ? 0 : 2) + (e.format === 'parquet' ? 0 : 1);
  return [...exports].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * The export to read: the one chosen in Settings when it exists and is usable, otherwise the best usable one.
 * null when nothing is usable.
 */
export function pickExport(exports: CurExport[], preferredId?: string): CurExport | null {
  const wanted = preferredId ? exports.find((e) => e.id === preferredId) : undefined;
  if (wanted?.usable) return wanted;
  return rankExports(exports).find((e) => e.usable) ?? null;
}

export interface ExportListing {
  exports: CurExport[];
  /** set when one (or both) of the listing APIs failed; `exports` still holds whatever the other returned */
  error?: { message: string; missingPermission?: string };
}

interface Failure {
  api: string;
  message: string;
  missingPermission?: string;
}

function failure(api: string, e: unknown, action: string): Failure {
  const w = classifyError('cost-and-usage-report', e, action);
  if (isAccessDenied(e) && w.missingPermission) return { api, message: `CloudPennies is not allowed to list ${api} (${w.missingPermission}).`, missingPermission: w.missingPermission };
  return { api, message: `Could not list ${api}: ${w.message}`, ...(w.missingPermission ? { missingPermission: w.missingPermission } : {}) };
}

/**
 * List every export on the account. A failure of one API never hides the results of the other;
 * it is reported in `error` instead. Never throws.
 */
export async function listCurExports(credentials: Creds): Promise<ExportListing> {
  const cfg = { region: BILLING_REGION, credentials, maxAttempts: 4 };
  const exports: CurExport[] = [];
  const failures: Failure[] = [];

  const dataExports = async () => {
    const client = new BCMDataExportsClient(cfg);
    try {
      const arns: string[] = [];
      let NextToken: string | undefined;
      let pages = 0;
      do {
        const r = await client.send(new ListExportsCommand({ MaxResults: 100, NextToken }));
        for (const x of r.Exports ?? []) if (x.ExportArn) arns.push(x.ExportArn);
        NextToken = r.NextToken;
      } while (NextToken && ++pages < MAX_PAGES);
      let detailFailure: Failure | undefined;
      for (const ExportArn of arns.slice(0, MAX_EXPORTS)) {
        try {
          const r = await client.send(new GetExportCommand({ ExportArn }));
          if (r.Export) exports.push(mapDataExport({ ...r.Export, ExportArn: r.Export.ExportArn ?? ExportArn }));
        } catch (e) {
          detailFailure ??= failure('Data Exports', e, 'bcm-data-exports:GetExport');
        }
      }
      if (detailFailure) failures.push(detailFailure);
    } catch (e) {
      failures.push(failure('Data Exports', e, 'bcm-data-exports:ListExports'));
    } finally {
      client.destroy();
    }
  };

  const legacy = async () => {
    const client = new CostAndUsageReportServiceClient(cfg);
    try {
      let NextToken: string | undefined;
      let pages = 0;
      do {
        const r = await client.send(new DescribeReportDefinitionsCommand({ NextToken }));
        for (const d of r.ReportDefinitions ?? []) if (d.ReportName) exports.push(mapLegacyReport(d));
        NextToken = r.NextToken;
      } while (NextToken && ++pages < MAX_PAGES);
    } catch (e) {
      failures.push(failure('legacy Cost and Usage Reports', e, 'cur:DescribeReportDefinitions'));
    } finally {
      client.destroy();
    }
  };

  await Promise.all([dataExports(), legacy()]);

  const ranked = rankExports(exports);
  if (!failures.length) return { exports: ranked };
  const perms = [...new Set(failures.map((f) => f.missingPermission).filter((p): p is string => !!p))];
  return {
    exports: ranked,
    error: { message: failures.map((f) => f.message).join(' '), ...(perms.length ? { missingPermission: perms.join(', ') } : {}) },
  };
}
