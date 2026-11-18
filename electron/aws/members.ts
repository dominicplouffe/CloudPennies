// Member accounts of an AWS Organization: which ones to inspect, and how to get into them (STS AssumeRole
// on a read-only role that exists in every member account, see docs/MEMBER_ROLE.md).
import { AssumeRoleCommand, type STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import type { AccountInfo, CostRow, ResourceFindings, ScanWarning } from '../../src/core/types';

export const MEMBER_SECTION = 'member-accounts';
export const MEMBER_ACCOUNT_CAP = 40;
export const MEMBER_MIN_SPEND = 1;
export const MEMBER_CONCURRENCY = 3;
export const MEMBER_SESSION_NAME = 'CloudPennies';
export const MEMBER_SESSION_SECONDS = 3600;

export type Partition = 'aws' | 'aws-us-gov' | 'aws-cn';

/** Partition of the caller, read from its ARN (`arn:aws-us-gov:iam::…`). Anything unknown is the standard partition. */
export function partitionOf(arn: string | undefined): Partition {
  const p = /^arn:([^:]+):/.exec(arn ?? '')?.[1];
  return p === 'aws-us-gov' || p === 'aws-cn' ? p : 'aws';
}

/** A region whose STS endpoint exists in the partition. */
export function stsRegion(partition: Partition): string {
  return partition === 'aws-us-gov' ? 'us-gov-west-1' : partition === 'aws-cn' ? 'cn-north-1' : 'us-east-1';
}

/** Trimmed role name (a leading "/" or "role/" is tolerated; a path such as `ops/Name` is kept). */
export function normalizeRoleName(name: string | undefined | null): string {
  return (name ?? '').trim().replace(/^\/+/, '').replace(/^role\//, '');
}

/** IAM role names: letters, digits and `+=,.@_-`, at most 64 characters (optionally preceded by a path). */
export function isValidRoleName(name: string): boolean {
  if (!/^[\w+=,.@/-]+$/.test(name) || name.endsWith('/') || name.includes('//')) return false;
  const base = name.slice(name.lastIndexOf('/') + 1);
  return base.length >= 1 && base.length <= 64;
}

export function memberRoleArn(partition: Partition, accountId: string, roleName: string): string {
  return `arn:${partition}:iam::${accountId}:role/${roleName}`;
}

export interface MemberAccount extends AccountInfo {
  /** spend over the window used for ordering (last 30 days) */
  spend: number;
}

/**
 * Member accounts worth inspecting: every linked account except the caller's own, with at least
 * `minSpend` of spend since `since`, highest spend first, at most `cap`.
 * `dailyByAccount` rows are keyed by [LINKED_ACCOUNT]. If the account list could not be read, the
 * account ids seen in the cost rows are used instead.
 */
export function selectMemberAccounts(
  accounts: AccountInfo[],
  dailyByAccount: CostRow[],
  ownAccountId: string,
  since: string,
  opts: { minSpend?: number; cap?: number } = {},
): MemberAccount[] {
  const { minSpend = MEMBER_MIN_SPEND, cap = MEMBER_ACCOUNT_CAP } = opts;
  const spend = new Map<string, number>();
  for (const r of dailyByAccount) {
    const id = r.keys[0];
    if (!id || r.date < since) continue;
    spend.set(id, (spend.get(id) ?? 0) + r.cost);
  }
  const known: AccountInfo[] = accounts.length ? accounts : [...spend.keys()].map((id) => ({ id, name: id }));
  const seen = new Set<string>([ownAccountId]);
  const out: MemberAccount[] = [];
  for (const a of known) {
    if (seen.has(a.id) || !/^\d{12}$/.test(a.id)) continue;
    seen.add(a.id);
    const s = spend.get(a.id) ?? 0;
    if (s < minSpend) continue;
    out.push({ id: a.id, name: a.name, spend: s });
  }
  out.sort((a, b) => b.spend - a.spend || (a.id < b.id ? -1 : 1));
  return out.slice(0, Math.max(0, cap));
}

/** "acme-prod", or "account 111122223333" when the account has no name */
export const accountLabel = (a: AccountInfo): string => (a.name && a.name !== a.id ? a.name : `account ${a.id}`);

/** Mark every finding with the account it was found in. */
export function stampAccount(f: ResourceFindings, account: string): ResourceFindings {
  for (const list of [f.logGroups, f.dashboards, f.volumes, f.addresses, f.loadBalancers, f.stoppedInstances] as { account?: string }[][]) {
    for (const item of list) item.account = account;
  }
  return f;
}

const plural = (n: number): string => `${n} member account${n === 1 ? '' : 's'}`;

/** The single warning for every account whose role could not be assumed. */
export function assumeRoleWarning(failedIds: string[], attempted: number, roleName: string): ScanWarning {
  const shown = failedIds.slice(0, 5).join(', ');
  const more = failedIds.length > 5 ? `, and ${failedIds.length - 5} more` : '';
  return {
    section: MEMBER_SECTION,
    message:
      `Could not enter ${failedIds.length} of ${plural(attempted)} (${shown}${more}), so their resources were not inspected. ` +
      `Create the role "${roleName}" in each member account, trusting the management account, and allow this user sts:AssumeRole on it — see docs/MEMBER_ROLE.md.`,
  };
}

/** Informational: there are member accounts with spend, but no role name is configured. */
export function membersNotInspectedWarning(count: number): ScanWarning {
  return {
    section: MEMBER_SECTION,
    message:
      `Resources in ${plural(count)} were not inspected: the resource scan only covered the connected account. ` +
      'Set a member role name in Settings to include them (see docs/MEMBER_ROLE.md).',
  };
}

export function invalidRoleNameWarning(roleName: string): ScanWarning {
  return {
    section: MEMBER_SECTION,
    message: `"${roleName.slice(0, 80)}" is not a valid IAM role name, so member accounts were not inspected. Enter just the role name (for example CloudPenniesReadOnly) in Settings.`,
  };
}

export function memberCapWarning(inspected: number, skipped: number): ScanWarning {
  return {
    section: MEMBER_SECTION,
    message: `Only the ${inspected} highest-spending member accounts are inspected; ${skipped} smaller one${skipped === 1 ? ' was' : 's were'} skipped.`,
  };
}

/** Temporary read-only credentials for one member account. Throws when the role cannot be assumed. */
export async function assumeMemberRole(sts: Pick<STSClient, 'send'>, roleArn: string): Promise<AwsCredentialIdentity> {
  const r = await sts.send(new AssumeRoleCommand({ RoleArn: roleArn, RoleSessionName: MEMBER_SESSION_NAME, DurationSeconds: MEMBER_SESSION_SECONDS }));
  const c = r.Credentials;
  if (!c?.AccessKeyId || !c.SecretAccessKey) throw new Error('STS returned no credentials');
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    ...(c.SessionToken ? { sessionToken: c.SessionToken } : {}),
    ...(c.Expiration ? { expiration: c.Expiration } : {}),
  };
}
