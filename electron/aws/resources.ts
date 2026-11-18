// Optional resource-level ("deep") scan: read-only describe calls in the regions where money is being spent.
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient, DescribeAlarmsCommand, ListDashboardsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudTrailClient, LookupEventsCommand } from '@aws-sdk/client-cloudtrail';
import {
  DescribeAddressesCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  DescribeLoadBalancersCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@aws-sdk/types';
import type { DashboardInfo, ResourceFindings, VolumeInfo } from '../../src/core/types';
import { classifyError, type WarningSink } from './errors';
import { nameTag, parseDashboardName, parseStoppedSince } from './mappers';
import { pool, sleep } from './pool';

export type Creds = AwsCredentialIdentity | AwsCredentialIdentityProvider;

const LOG_GROUP_CAP = 5000;
const VOLUME_CAP = 5000;
const LB_CAP = 100;
const TRAIL_PAGE_CAP = 40;
const TRAIL_DELAY_MS = 550; // LookupEvents is limited to 2 requests/second per account per region
const DAY = 86_400_000;

export const emptyFindings = (): ResourceFindings => ({
  logGroups: [],
  dashboards: [],
  alarms: { total: 0, insufficientData: 0, noActions: 0 },
  volumes: [],
  oldSnapshots: { count: 0, totalGb: 0 },
  addresses: [],
  loadBalancers: [],
  stoppedInstances: [],
});

export function mergeFindings(into: ResourceFindings, part: ResourceFindings): void {
  into.logGroups.push(...part.logGroups);
  into.dashboards.push(...part.dashboards);
  into.alarms.total += part.alarms.total;
  into.alarms.insufficientData += part.alarms.insufficientData;
  into.alarms.noActions += part.alarms.noActions;
  into.volumes.push(...part.volumes);
  into.oldSnapshots.count += part.oldSnapshots.count;
  into.oldSnapshots.totalGb += part.oldSnapshots.totalGb;
  into.addresses.push(...part.addresses);
  into.loadBalancers.push(...part.loadBalancers);
  into.stoppedInstances.push(...part.stoppedInstances);
}

/** Scan one region. Every call is independently guarded; failures become (de-duplicated) warnings. */
export async function scanRegion(region: string, credentials: Creds, warnings: WarningSink, now: Date): Promise<ResourceFindings> {
  const cfg = { region, credentials, maxAttempts: 6, retryMode: 'adaptive' as const };
  const logs = new CloudWatchLogsClient(cfg);
  const cw = new CloudWatchClient(cfg);
  const trail = new CloudTrailClient(cfg);
  const ec2 = new EC2Client(cfg);
  const elb = new ElasticLoadBalancingV2Client(cfg);
  const out = emptyFindings();

  const guard = async (section: string, action: string, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn();
      return true;
    } catch (e) {
      warnings.add(classifyError(section, e, action));
      return false;
    }
  };

  const logGroups = guard('log-groups', 'logs:DescribeLogGroups', async () => {
    let nextToken: string | undefined;
    do {
      const r = await logs.send(new DescribeLogGroupsCommand({ limit: 50, nextToken }));
      for (const g of r.logGroups ?? []) {
        if (!g.logGroupName) continue;
        out.logGroups.push({
          name: g.logGroupName,
          region,
          storedBytes: g.storedBytes ?? 0,
          retentionDays: g.retentionInDays ?? null,
          ...(g.logGroupClass ? { logClass: g.logGroupClass } : {}),
          ...(g.creationTime ? { createdAt: new Date(g.creationTime).toISOString() } : {}),
        });
      }
      nextToken = r.nextToken;
    } while (nextToken && out.logGroups.length < LOG_GROUP_CAP);
  });

  const alarms = guard('alarms', 'cloudwatch:DescribeAlarms', async () => {
    let NextToken: string | undefined;
    let pages = 0;
    do {
      const r = await cw.send(new DescribeAlarmsCommand({ AlarmTypes: ['MetricAlarm', 'CompositeAlarm'], MaxRecords: 100, NextToken }));
      for (const a of [...(r.MetricAlarms ?? []), ...(r.CompositeAlarms ?? [])]) {
        out.alarms.total++;
        if (a.StateValue === 'INSUFFICIENT_DATA') out.alarms.insufficientData++;
        if (!(a.AlarmActions?.length || a.OKActions?.length || a.InsufficientDataActions?.length)) out.alarms.noActions++;
      }
      NextToken = r.NextToken;
    } while (NextToken && ++pages < 100);
  });

  const dashboards = (async () => {
    const found: DashboardInfo[] = [];
    const ok = await guard('dashboards', 'cloudwatch:ListDashboards', async () => {
      let NextToken: string | undefined;
      do {
        const r = await cw.send(new ListDashboardsCommand({ NextToken }));
        for (const d of r.DashboardEntries ?? []) {
          if (!d.DashboardName) continue;
          found.push({ name: d.DashboardName, region, ...(d.LastModified ? { lastModified: d.LastModified.toISOString() } : {}) });
        }
        NextToken = r.NextToken;
      } while (NextToken);
    });
    if (!ok || !found.length) return;
    // When was each dashboard last opened? CloudTrail keeps 90 days of management events, newest first.
    const wanted = new Set(found.map((d) => d.name));
    const viewed = new Map<string, string>();
    let complete = false;
    const lookedUp = await guard('dashboard-views', 'cloudtrail:LookupEvents', async () => {
      let NextToken: string | undefined;
      let pages = 0;
      for (;;) {
        const r = await trail.send(
          new LookupEventsCommand({
            LookupAttributes: [{ AttributeKey: 'EventName', AttributeValue: 'GetDashboard' }],
            StartTime: new Date(now.getTime() - 90 * DAY),
            EndTime: now,
            MaxResults: 50,
            NextToken,
          }),
        );
        for (const ev of r.Events ?? []) {
          const name = parseDashboardName(ev.CloudTrailEvent);
          if (name && wanted.has(name) && !viewed.has(name) && ev.EventTime) viewed.set(name, ev.EventTime.toISOString());
        }
        NextToken = r.NextToken;
        pages++;
        if (!NextToken || viewed.size === wanted.size) {
          complete = true;
          break;
        }
        if (pages >= TRAIL_PAGE_CAP) break;
        await sleep(TRAIL_DELAY_MS);
      }
    });
    for (const d of found) {
      const v = viewed.get(d.name);
      // null only when the whole 90-day history was read and holds no view; otherwise leave undefined (unknown)
      if (v) d.lastViewed = v;
      else if (lookedUp && complete) d.lastViewed = null;
    }
    out.dashboards.push(...found);
  })();

  const compute = (async () => {
    const sizes = new Map<string, number>();
    await guard('volumes', 'ec2:DescribeVolumes', async () => {
      let NextToken: string | undefined;
      do {
        const r = await ec2.send(new DescribeVolumesCommand({ MaxResults: 500, NextToken }));
        for (const v of r.Volumes ?? []) {
          if (!v.VolumeId) continue;
          sizes.set(v.VolumeId, v.Size ?? 0);
          if (out.volumes.length >= VOLUME_CAP) continue;
          const info: VolumeInfo = {
            id: v.VolumeId,
            region,
            sizeGb: v.Size ?? 0,
            type: v.VolumeType ?? 'unknown',
            attached: (v.Attachments?.length ?? 0) > 0,
          };
          if (v.CreateTime) info.createdAt = v.CreateTime.toISOString();
          const name = nameTag(v.Tags);
          if (name) info.name = name;
          if (v.Iops !== undefined) info.iops = v.Iops;
          out.volumes.push(info);
        }
        NextToken = r.NextToken;
      } while (NextToken && sizes.size < VOLUME_CAP * 4);
    });
    await guard('stopped-instances', 'ec2:DescribeInstances', async () => {
      let NextToken: string | undefined;
      do {
        const r = await ec2.send(
          new DescribeInstancesCommand({ Filters: [{ Name: 'instance-state-name', Values: ['stopped'] }], MaxResults: 500, NextToken }),
        );
        for (const res of r.Reservations ?? []) {
          for (const i of res.Instances ?? []) {
            if (!i.InstanceId) continue;
            const ebsGb = (i.BlockDeviceMappings ?? []).reduce((a, b) => a + (sizes.get(b.Ebs?.VolumeId ?? '') ?? 0), 0);
            const name = nameTag(i.Tags);
            const since = parseStoppedSince(i.StateTransitionReason);
            out.stoppedInstances.push({
              id: i.InstanceId,
              region,
              type: i.InstanceType ?? 'unknown',
              ...(name ? { name } : {}),
              ...(since ? { stoppedSince: since } : {}),
              ebsGb,
            });
          }
        }
        NextToken = r.NextToken;
      } while (NextToken && out.stoppedInstances.length < 2000);
    });
  })();

  const addresses = guard('addresses', 'ec2:DescribeAddresses', async () => {
    const r = await ec2.send(new DescribeAddressesCommand({}));
    for (const a of r.Addresses ?? []) {
      const ip = a.PublicIp ?? a.CarrierIp ?? a.CustomerOwnedIp;
      if (!ip) continue;
      out.addresses.push({
        ip,
        region,
        ...(a.AllocationId ? { allocationId: a.AllocationId } : {}),
        associated: !!(a.AssociationId || a.InstanceId || a.NetworkInterfaceId),
      });
    }
  });

  const snapshots = guard('snapshots', 'ec2:DescribeSnapshots', async () => {
    const cutoff = now.getTime() - 365 * DAY;
    let NextToken: string | undefined;
    let pages = 0;
    do {
      const r = await ec2.send(new DescribeSnapshotsCommand({ OwnerIds: ['self'], MaxResults: 1000, NextToken }));
      for (const s of r.Snapshots ?? []) {
        if (s.StartTime && s.StartTime.getTime() < cutoff) {
          out.oldSnapshots.count++;
          out.oldSnapshots.totalGb += s.VolumeSize ?? 0;
        }
      }
      NextToken = r.NextToken;
    } while (NextToken && ++pages < 100);
  });

  const loadBalancers = guard('load-balancers', 'elasticloadbalancing:DescribeLoadBalancers', async () => {
    const lbs: { arn: string; name: string; type: string; createdAt?: string }[] = [];
    let Marker: string | undefined;
    do {
      const r = await elb.send(new DescribeLoadBalancersCommand({ Marker, PageSize: 400 }));
      for (const lb of r.LoadBalancers ?? []) {
        if (!lb.LoadBalancerArn) continue;
        lbs.push({
          arn: lb.LoadBalancerArn,
          name: lb.LoadBalancerName ?? lb.LoadBalancerArn,
          type: lb.Type ?? 'application',
          ...(lb.CreatedTime ? { createdAt: lb.CreatedTime.toISOString() } : {}),
        });
      }
      Marker = r.NextMarker;
    } while (Marker && lbs.length < LB_CAP);
    const inspected = lbs.slice(0, LB_CAP);
    if (!inspected.length) return;
    const wanted = new Set(inspected.map((l) => l.arn));

    // target group -> load balancers, then count registered targets per target group
    const tgs: { arn: string; lbs: string[] }[] = [];
    const tgOk = await guard('load-balancers', 'elasticloadbalancing:DescribeTargetGroups', async () => {
      let m: string | undefined;
      let pages = 0;
      do {
        const r = await elb.send(new DescribeTargetGroupsCommand({ Marker: m, PageSize: 400 }));
        for (const tg of r.TargetGroups ?? []) {
          const attached = (tg.LoadBalancerArns ?? []).filter((a) => wanted.has(a));
          if (tg.TargetGroupArn && attached.length) tgs.push({ arn: tg.TargetGroupArn, lbs: attached });
        }
        m = r.NextMarker;
      } while (m && ++pages < 25);
    });
    if (!tgOk) return; // cannot tell idle from busy without target groups: report nothing rather than guess
    const targets = new Map<string, number>(inspected.map((l) => [l.arn, 0]));
    const unknown = new Set<string>();
    await pool(
      tgs.map((tg) => async () => {
        try {
          const r = await elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: tg.arn }));
          const n = r.TargetHealthDescriptions?.length ?? 0;
          for (const a of tg.lbs) targets.set(a, (targets.get(a) ?? 0) + n);
        } catch (e) {
          warnings.add(classifyError('load-balancers', e, 'elasticloadbalancing:DescribeTargetHealth'));
          for (const a of tg.lbs) unknown.add(a);
        }
      }),
      4,
    );
    for (const lb of inspected) {
      if (unknown.has(lb.arn)) continue;
      out.loadBalancers.push({ name: lb.name, arn: lb.arn, region, type: lb.type, targets: targets.get(lb.arn) ?? 0, ...(lb.createdAt ? { createdAt: lb.createdAt } : {}) });
    }
  });

  await Promise.all([logGroups, alarms, dashboards, compute, addresses, snapshots, loadBalancers]);
  for (const c of [logs, cw, trail, ec2, elb]) c.destroy();
  return out;
}
