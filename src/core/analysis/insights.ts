// Savings opportunities. Three tiers of evidence, strongest first:
//   1. AWS's own recommendations (Cost Optimization Hub, Cost Explorer)
//   2. The optional read-only resource scan (exact resources)
//   3. Billing-data heuristics on usage types (work with a billing-only key)
// When a stronger tier covers a topic, the weaker heuristic is suppressed.

import type { Anomaly, CommitmentSummary, Dim, Insight, InsightCategory, Level, TagCoverage } from '../types';
import { GRAVITON_EQUIV, OLD_GEN, instanceFamily, shortService, usageInstanceType } from '../catalog';
import { bytes, diffDays, fmtDateLong, joinList, money, pct, sum } from '../util';
import type { Ctx } from './context';

const CW = /CloudWatch/;
const EC2ANY = /Elastic Compute Cloud|EC2/;
const HOURS = 730;

const EBS_PRICE: Record<string, number> = { gp2: 0.1, gp3: 0.08, io1: 0.125, io2: 0.125, st1: 0.045, sc1: 0.015, standard: 0.05 };

function thread(label: string, service: string | undefined, usageTypes?: string[], groupBy: Dim = 'USAGE_TYPE') {
  const filters: Partial<Record<Dim, string[]>> = {};
  if (service) filters.SERVICE = [service];
  if (usageTypes?.length) {
    filters.USAGE_TYPE = [...new Set(usageTypes)];
    if (groupBy === 'USAGE_TYPE') groupBy = 'REGION';
  }
  return { label, filters, groupBy };
}

const svcOf = (leaves: { service: string }[]) => leaves[0]?.service;
const utOf = (leaves: { usageType: string }[]) => leaves.map((l) => l.usageType);

export function buildInsights(ctx: Ctx, anomalies: Anomaly[], commitments: CommitmentSummary, tags: TagCoverage | null): Insight[] {
  const { snap } = ctx;
  const out: Insight[] = [];
  const res = snap.resources;
  const today = snap.meta.today;
  const add = (i: Insight) => out.push(i);

  // ───────────── Commitments ─────────────
  const c = snap.commitments;

  for (const e of commitments.expirations.filter((e) => e.daysLeft <= 60)) {
    add({
      id: 'expiring-' + e.id,
      category: 'commitments',
      title: `${e.label} expires in ${e.daysLeft} day${e.daysLeft === 1 ? '' : 's'}`,
      summary: `On ${fmtDateLong(e.end)} this commitment ends and the usage it covers goes back to on-demand rates — about ${money(e.monthlyExposure)}/month more for the same workload unless you renew or replace it.`,
      monthlySavings: 0,
      confidence: 'high',
      effort: 'low',
      risk: 'low',
      source: 'CloudPennies',
      urgent: true,
      evidence: [
        { label: 'Commitment', value: e.detail },
        { label: 'Ends', value: fmtDateLong(e.end) },
        { label: 'Utilization (30 days)', value: pct(e.utilizationPct) },
        { label: 'Discount at risk', value: `${money(e.monthlyExposure)}/month` },
      ],
      steps: [
        e.utilizationPct < 85 ? `It is only ${pct(e.utilizationPct)} utilized — renew for less than the current commitment.` : 'Utilization is healthy — plan to renew at a similar level.',
        e.kind === 'Savings Plan' ? 'Savings Plans do not auto-renew. In Billing → Savings Plans → Inventory, choose "Renew" to queue a replacement that starts the moment this one ends.' : 'Reserved Instances do not auto-renew. Queue a replacement purchase for the expiry date in the service console (EC2 supports queued purchases; for RDS/ElastiCache set a calendar reminder).',
        'Before renewing, check whether the workload has changed size or moved to Graviton — a Compute Savings Plan follows you across families and regions.',
      ],
    });
  }

  // Under-used commitments
  for (const sp of c.savingsPlans.filter((s) => s.utilizationPct < 90 && s.unusedCommitment > 5)) {
    add({
      id: 'unused-' + sp.id,
      category: 'commitments',
      title: `${sp.type === 'EC2Instance' ? 'EC2 Instance' : sp.type} Savings Plan is only ${pct(sp.utilizationPct)} used`,
      summary: `You are paying for ${money(sp.hourlyCommitment, { cents: true })}/hour of committed spend but ${money(sp.unusedCommitment)} of it went unused in the last 30 days. Unused commitment is pure waste.`,
      monthlySavings: sp.unusedCommitment,
      confidence: 'high',
      effort: 'medium',
      risk: 'low',
      source: 'Cost Explorer',
      evidence: [
        { label: 'Hourly commitment', value: money(sp.hourlyCommitment, { cents: true }) },
        { label: 'Unused, last 30 days', value: money(sp.unusedCommitment) },
        { label: 'Ends', value: fmtDateLong(sp.end) },
      ],
      steps: [
        sp.type === 'EC2Instance' ? `This plan only covers ${sp.instanceFamily ?? 'one instance family'} in ${sp.region ?? 'one region'}. Move steady workloads onto that family to soak it up.` : 'Compute Savings Plans apply to EC2, Fargate and Lambda in any region — check whether usage dropped or moved to Spot.',
        'Savings Plans cannot be cancelled, so the fix is to bring matching usage back under it — and to commit to less at renewal.',
      ],
    });
  }
  for (const ri of c.reservations.filter((r) => r.utilizationPct < 90 && r.unusedCost > 5)) {
    add({
      id: 'unused-' + ri.id,
      category: 'commitments',
      title: `${shortService(ri.service)} reservation is only ${pct(ri.utilizationPct)} used`,
      summary: `${ri.count} × ${ri.instanceType} reserved in ${ri.region}, but ${Math.round(ri.unusedHours).toLocaleString()} reserved hours had nothing running against them in the last 30 days — ${money(ri.unusedCost)} paid for nothing.`,
      monthlySavings: ri.unusedCost,
      confidence: 'high',
      effort: 'medium',
      risk: 'low',
      service: ri.service,
      source: 'Cost Explorer',
      evidence: [
        { label: 'Reservation', value: `${ri.count} × ${ri.instanceType}${ri.platform ? ` (${ri.platform})` : ''}` },
        { label: 'Unused, last 30 days', value: money(ri.unusedCost) },
        { label: 'Ends', value: fmtDateLong(ri.end) },
      ],
      steps: [
        `Find on-demand ${shortService(ri.service)} nodes in ${ri.region} that could be switched to ${instanceFamily(ri.instanceType) ?? ri.instanceType} to use the reservation (size-flexible within the family for most engines).`,
        /Compute Cloud/.test(ri.service) ? 'Standard EC2 RIs can be listed on the Reserved Instance Marketplace; Convertible RIs can be exchanged.' : 'This reservation cannot be sold. Do not renew it at the same size.',
      ],
      thread: thread(shortService(ri.service), ri.service),
    });
  }

  // What to reserve right now
  const spByType = new Map<string, typeof c.spRecommendations>();
  for (const r of c.spRecommendations) {
    if (r.estimatedMonthlySavings <= 0) continue;
    if (!spByType.has(r.type)) spByType.set(r.type, []);
    spByType.get(r.type)!.push(r);
  }
  // Compute and EC2 Instance plans address the same spend: keep Compute (more flexible).
  if (spByType.has('Compute')) spByType.delete('EC2Instance');
  const soonExpiringSp = commitments.expirations.filter((e) => e.kind === 'Savings Plan' && e.daysLeft <= 45);
  for (const [type, recs] of spByType) {
    const primary = recs.find((r) => r.termYears === 1 && /no upfront/i.test(r.paymentOption)) ?? recs.sort((a, b) => a.termYears - b.termYears)[0];
    const alt = recs.filter((r) => r !== primary).sort((a, b) => b.estimatedMonthlySavings - a.estimatedMonthlySavings)[0];
    const name = type === 'EC2Instance' ? 'EC2 Instance' : type;
    add({
      id: 'sp-buy-' + type,
      category: 'commitments',
      title: `Buy a ${name} Savings Plan: ${money(primary.hourlyCommitment, { cents: true })}/hour`,
      summary: `${money(primary.currentMonthlyOnDemand)}/month of steady ${type === 'Database' ? 'database' : type === 'SageMaker' ? 'SageMaker' : 'compute'} usage is paying full on-demand rates. A ${primary.termYears}-year, ${primary.paymentOption.toLowerCase()} commitment cuts that by about ${pct(primary.estimatedSavingsPct)} with nothing to change in your infrastructure.`,
      monthlySavings: primary.estimatedMonthlySavings,
      confidence: 'high',
      effort: 'low',
      risk: primary.termYears === 3 ? 'medium' : 'low',
      source: 'Cost Explorer',
      urgent: primary.estimatedMonthlySavings > ctx.last30 * 0.02,
      evidence: [
        { label: 'Recommended commitment', value: `${money(primary.hourlyCommitment, { cents: true })}/hour (${money(primary.hourlyCommitment * HOURS)}/month)` },
        { label: 'Term', value: `${primary.termYears} year, ${primary.paymentOption}` },
        { label: 'On-demand spend addressed', value: `${money(primary.currentMonthlyOnDemand)}/month` },
        { label: 'Based on', value: `last ${primary.lookbackDays} days of usage` },
        ...(alt ? [{ label: `Alternative: ${alt.termYears}-year, ${alt.paymentOption}`, value: `${money(alt.estimatedMonthlySavings)}/month saved (${pct(alt.estimatedSavingsPct)})${alt.upfrontCost > 0 ? `, ${money(alt.upfrontCost)} upfront` : ''}` }] : []),
      ],
      steps: [
        'Fix waste first: stop idle instances and rightsize before committing, so you do not lock in spend you are about to remove.',
        `A cautious first step is to buy 70–80% of the recommendation (about ${money(primary.hourlyCommitment * 0.75, { cents: true })}/hour), then top up next month. Several smaller plans with staggered end dates are easier to adjust than one big one.`,
        ...(soonExpiringSp.length ? [`Note: an existing Savings Plan expires in ${soonExpiringSp[0].daysLeft} days. AWS's recommendation only looks at usage that is on-demand today, so plan the renewal on top of this purchase.`] : []),
        'Purchase in Billing and Cost Management → Savings Plans → Purchase Savings Plans. It takes effect immediately.',
      ],
    });
  }

  const riBySvc = new Map<string, typeof c.riRecommendations>();
  for (const r of c.riRecommendations) {
    if (r.estimatedMonthlySavings <= 0) continue;
    if (!riBySvc.has(r.service)) riBySvc.set(r.service, []);
    riBySvc.get(r.service)!.push(r);
  }
  for (const [service, recs] of riBySvc) {
    recs.sort((a, b) => b.estimatedMonthlySavings - a.estimatedMonthlySavings);
    const total = sum(recs.map((r) => r.estimatedMonthlySavings));
    const upfront = sum(recs.map((r) => r.upfrontCost));
    const svc = shortService(service);
    const dbSp = spByType.has('Database') && /Relational|ElastiCache|DynamoDB|MemoryDB|Neptune|DocumentDB/.test(service);
    add({
      id: 'ri-buy-' + service,
      category: 'commitments',
      title: `Reserve ${svc} capacity: ${recs.length === 1 ? `${recs[0].count} × ${recs[0].instanceType}` : `${recs.length} reservations`}`,
      summary: `${svc} nodes that have been running steadily are billed on-demand. ${/Relational|ElastiCache|OpenSearch|Redshift|MemoryDB/.test(service) ? 'Compute Savings Plans do not cover this service, so a reservation is the way to get the discount' : 'A reservation gets the discount'} — about ${pct(recs[0].estimatedSavingsPct)} off.`,
      monthlySavings: total,
      confidence: 'high',
      effort: 'low',
      risk: 'low',
      service,
      source: 'Cost Explorer',
      evidence: [
        { label: 'Term', value: `${recs[0].termYears} year, ${recs[0].paymentOption}` },
        { label: 'Upfront cost', value: upfront > 0 ? money(upfront) : 'None' },
        { label: 'Based on', value: `last ${recs[0].lookbackDays} days of usage` },
        ...(dbSp ? [{ label: 'Also consider', value: 'A Database Savings Plan covers the same usage with more flexibility — compare before buying both.' }] : []),
      ],
      resources: recs.slice(0, 12).map((r) => ({
        id: `${r.count} × ${r.instanceType}`,
        detail: `${r.region}${r.platform ? ` · ${r.platform}` : ''}${r.breakEvenMonths ? ` · breaks even in ${r.breakEvenMonths.toFixed(1)} mo` : ''}`,
        monthlySavings: r.estimatedMonthlySavings,
      })),
      steps: [
        'Confirm these nodes are long-lived (not about to be resized, migrated to Graviton or decommissioned).',
        `Purchase in the ${svc} console under "Reserved ${/OpenSearch/.test(service) ? 'instances' : 'nodes / instances'}". The discount applies automatically to matching running nodes.`,
      ],
      thread: thread(svc, service),
    });
  }

  // ───────────── AWS recommendations (Cost Optimization Hub) ─────────────
  const hub = snap.hubRecommendations.filter((r) => !/Purchase/i.test(r.actionType) && r.monthlySavings > 0);
  const hubHas = (type: RegExp, action: RegExp) => hub.some((r) => type.test(r.resourceType) && action.test(r.actionType));
  const hubGroups = new Map<string, typeof hub>();
  for (const r of hub) {
    const k = `${r.actionType}|${r.resourceType}`;
    if (!hubGroups.has(k)) hubGroups.set(k, []);
    hubGroups.get(k)!.push(r);
  }
  const RES_NAME: Record<string, [string, string, string | undefined]> = {
    // resourceType: [singular, plural, CE service]
    Ec2Instance: ['EC2 instance', 'EC2 instances', 'Amazon Elastic Compute Cloud - Compute'],
    EbsVolume: ['EBS volume', 'EBS volumes', 'EC2 - Other'],
    LambdaFunction: ['Lambda function', 'Lambda functions', 'AWS Lambda'],
    EcsService: ['ECS service', 'ECS services', 'Amazon Elastic Container Service'],
    RdsDbInstance: ['RDS instance', 'RDS instances', 'Amazon Relational Database Service'],
    RdsDbInstanceStorage: ['RDS storage volume', 'RDS storage volumes', 'Amazon Relational Database Service'],
    AuroraDbClusterStorage: ['Aurora cluster', 'Aurora clusters', 'Amazon Relational Database Service'],
    Ec2AutoScalingGroup: ['Auto Scaling group', 'Auto Scaling groups', 'Amazon Elastic Compute Cloud - Compute'],
    DynamoDbTable: ['DynamoDB table', 'DynamoDB tables', 'Amazon DynamoDB'],
    NatGateway: ['NAT gateway', 'NAT gateways', 'EC2 - Other'],
  };
  for (const [k, recs] of hubGroups) {
    const [action, type] = k.split('|');
    recs.sort((a, b) => b.monthlySavings - a.monthlySavings);
    const [one, many, service] = RES_NAME[type] ?? [type.replace(/([a-z])([A-Z])/g, '$1 $2'), type.replace(/([a-z])([A-Z])/g, '$1 $2') + 's', undefined];
    const nres = recs.length;
    const noun = nres === 1 ? one : many;
    const total = sum(recs.map((r) => r.monthlySavings));
    let title: string;
    let summary: string;
    let category: InsightCategory = 'rightsizing';
    let effort: Level = 'medium';
    let risk: Level = 'medium';
    let steps: string[];
    if (/Stop|Delete|Terminate/i.test(action)) {
      category = 'idle';
      effort = 'low';
      risk = 'low';
      title = `${nres} idle ${noun} to ${/Delete/i.test(action) ? 'delete' : 'stop'}`;
      summary = `AWS's own utilization data shows ${nres === 1 ? 'this resource has' : 'these resources have'} been doing nothing. You are paying full price for ${nres === 1 ? 'it' : 'them'}.`;
      steps = ['Confirm with the owner (check the Name/owner tags) that nothing depends on it.', /EbsVolume/.test(type) ? 'Take a final snapshot if in doubt, then delete the volume.' : 'Stop first rather than terminate; if nobody notices after two weeks, terminate and delete attached volumes.'];
    } else if (/Upgrade/i.test(action)) {
      category = 'modernize';
      effort = 'low';
      risk = 'low';
      title = /EbsVolume/.test(type) ? `Move ${nres} EBS ${nres === 1 ? 'volume' : 'volumes'} from gp2 to gp3` : `Upgrade ${nres} ${noun} to the current generation`;
      summary = /EbsVolume/.test(type) ? 'gp3 is 20% cheaper per GB than gp2 with the same or better baseline performance. The change is online: no downtime, no detach.' : `Newer generations cost less for the same work.`;
      steps = /EbsVolume/.test(type) ? ['Modify each volume type to gp3 in the EC2 console or with `aws ec2 modify-volume --volume-type gp3`.', 'For volumes over 1 TB, set gp3 IOPS/throughput to match what gp2 provided (3 IOPS per GB).'] : ['Schedule the change in a maintenance window; most upgrades need a restart.'];
    } else if (/Graviton/i.test(action)) {
      category = 'modernize';
      effort = /Rds|ElastiCache|OpenSearch/i.test(type) ? 'low' : 'high';
      risk = 'low';
      title = `Move ${nres} ${noun} to Graviton`;
      summary = `Graviton (Arm) instances cost less and usually perform better. ${/Rds/i.test(type) ? 'For managed databases this is an instance-class change — no application changes.' : 'Requires Arm-compatible builds of your software.'}`;
      steps = ['Change the instance class in a maintenance window.', 'If a reservation covers the current class, time the move for when it expires.'];
    } else if (/ScaleIn/i.test(action)) {
      title = `Scale in ${nres} ${noun}`;
      summary = 'These groups consistently run more capacity than their load needs.';
      steps = ['Lower the minimum/desired capacity or tighten the scaling policy target.'];
    } else {
      title = `Rightsize ${nres} ${noun}`;
      summary = `${nres === 1 ? 'This resource is' : 'These resources are'} larger than ${nres === 1 ? 'its' : 'their'} workload needs, according to AWS Compute Optimizer's utilization analysis.`;
      steps = [/Lambda/.test(type) ? 'Lower the configured memory to the recommended value.' : 'Resize during a maintenance window; rollback is a resize back.', 'If the fleet is managed by infrastructure-as-code, change it there so it does not drift back.'];
    }
    add({
      id: `hub-${action}-${type}`,
      category,
      title,
      summary,
      monthlySavings: total,
      confidence: 'high',
      effort,
      risk,
      service,
      source: 'Cost Optimization Hub',
      evidence: [
        { label: 'Resources', value: String(nres) },
        { label: 'Needs restart', value: recs.some((r) => r.restartNeeded) ? 'Yes' : 'No' },
        { label: 'Reversible', value: recs.every((r) => r.rollbackPossible !== false) ? 'Yes' : 'Partly' },
      ],
      resources: recs.slice(0, 25).map((r) => ({
        id: r.resourceId ?? r.id,
        detail: [r.currentSummary && r.recommendedSummary ? `${r.currentSummary} → ${r.recommendedSummary}` : (r.currentSummary ?? r.recommendedSummary), r.region, accountName(ctx, r.account)].filter(Boolean).join(' · '),
        monthlySavings: r.monthlySavings,
      })),
      steps,
      thread: service ? thread(shortService(service), service) : undefined,
    });
  }

  // Cost Explorer rightsizing, when the Hub did not already cover EC2
  if (snap.rightsizing.length && !hubHas(/Ec2Instance/, /Rightsize|Stop/)) {
    const term = snap.rightsizing.filter((r) => r.action === 'TERMINATE' && r.monthlySavings > 0);
    const mod = snap.rightsizing.filter((r) => r.action === 'MODIFY' && r.monthlySavings > 0);
    const mk = (recs: typeof term, idle: boolean) =>
      recs.length &&
      add({
        id: idle ? 'ce-terminate' : 'ce-rightsize',
        category: idle ? 'idle' : 'rightsizing',
        title: idle ? `${recs.length} idle EC2 ${recs.length === 1 ? 'instance' : 'instances'} to terminate` : `Rightsize ${recs.length} EC2 ${recs.length === 1 ? 'instance' : 'instances'}`,
        summary: idle ? 'Cost Explorer sees almost no CPU activity on these instances over the last two weeks.' : 'These instances peak well below their capacity. A smaller size does the same job.',
        monthlySavings: sum(recs.map((r) => r.monthlySavings)),
        confidence: 'medium',
        effort: idle ? 'low' : 'medium',
        risk: idle ? 'low' : 'medium',
        service: 'Amazon Elastic Compute Cloud - Compute',
        source: 'Cost Explorer',
        evidence: [{ label: 'Instances', value: String(recs.length) }],
        resources: recs
          .sort((a, b) => b.monthlySavings - a.monthlySavings)
          .slice(0, 25)
          .map((r) => ({ id: r.name ? `${r.name} (${r.resourceId})` : r.resourceId, detail: [idle ? r.currentType : `${r.currentType} → ${r.targetType}`, r.maxCpuPct !== undefined ? `max CPU ${r.maxCpuPct.toFixed(0)}%` : '', r.region].filter(Boolean).join(' · '), monthlySavings: r.monthlySavings })),
        steps: idle ? ['Confirm with the owner, stop the instance, and terminate after a quiet period.'] : ['Resize in a maintenance window (stop, change type, start).', 'CPU is only part of the picture — check memory if the CloudWatch agent is installed.'],
        thread: thread('EC2 Instances', 'Amazon Elastic Compute Cloud - Compute'),
      });
    mk(term, true);
    mk(mod, false);
  }

  // ───────────── Billing heuristics + resource scan ─────────────

  // Extended support surcharges
  const ext = ctx.find(null, /ExtendedSupport|extendedSupport/);
  if (ext.cost > 5) {
    const bySvc = new Map<string, number>();
    for (const l of ext.leaves) bySvc.set(l.service, (bySvc.get(l.service) ?? 0) + l.cost30);
    for (const [service, cost] of bySvc) {
      const isEks = /Kubernetes|EKS/.test(service);
      const ls = ext.leaves.filter((l) => l.service === service);
      add({
        id: 'ext-support-' + service,
        category: 'modernize',
        title: `${isEks ? 'EKS' : shortService(service)} Extended Support surcharge`,
        summary: isEks
          ? `At least one EKS cluster runs a Kubernetes version past standard support. AWS charges $0.60/hour per cluster instead of $0.10 — six times the price — until you upgrade.`
          : `A database is running an engine version AWS no longer supports for free. You pay a per-vCPU-hour penalty on top of the normal price until it is upgraded, and the penalty doubles in year three.`,
        monthlySavings: cost,
        confidence: 'high',
        effort: 'medium',
        risk: 'medium',
        service,
        source: 'CloudPennies',
        urgent: true,
        evidence: [
          { label: 'Surcharge, last 30 days', value: money(cost) },
          { label: 'Billing line', value: joinList([...new Set(ls.map((l) => l.u))]) },
        ],
        steps: isEks ? ['Find clusters on an old version: `aws eks list-clusters` then `describe-cluster` (look at `version`).', 'Upgrade the control plane one minor version at a time, then node groups and add-ons.'] : ['Identify the instance: RDS console → Databases → filter by engine version (MySQL 5.7, PostgreSQL 11/12 are the usual suspects).', 'Test a major-version upgrade on a snapshot restore, then use a Blue/Green deployment to switch with minimal downtime.'],
        thread: thread(shortService(service), service, utOf(ls)),
      });
    }
  }

  // Idle public IPv4
  const idleIp = ctx.find(null, /^(PublicIPv4:IdleAddress|ElasticIP:IdleAddress)/);
  const idleAddrs = res?.addresses.filter((a) => !a.associated) ?? [];
  if (idleIp.cost > 2 || idleAddrs.length > 0) {
    const cost = idleIp.cost > 2 ? idleIp.cost : idleAddrs.length * 0.005 * HOURS;
    add({
      id: 'idle-ipv4',
      category: 'idle',
      title: `${idleAddrs.length || Math.round(idleIp.usage / 720) || 'Several'} Elastic IPs attached to nothing`,
      summary: `Every public IPv4 address costs $0.005/hour (${money(0.005 * HOURS, { cents: true })}/month) whether or not anything is using it. These are allocated but not associated with a running resource.`,
      monthlySavings: cost,
      confidence: 'high',
      effort: 'low',
      risk: 'low',
      service: svcOf(idleIp.leaves),
      source: idleAddrs.length ? 'Resource scan' : 'CloudPennies',
      evidence: [{ label: 'Idle address cost, last 30 days', value: money(cost) }],
      resources: idleAddrs.slice(0, 30).map((a) => ({ id: a.ip, detail: `${a.region}${a.allocationId ? ` · ${a.allocationId}` : ''}`, monthlySavings: 0.005 * HOURS })),
      steps: ['EC2 console → Elastic IPs → filter "Associated instance ID: –".', 'Release each address you no longer need (make sure no DNS record or allow-list still points at it).'],
      thread: idleIp.leaves.length ? thread('Idle IPv4', svcOf(idleIp.leaves), utOf(idleIp.leaves)) : undefined,
    });
  }

  // gp2 → gp3 (billing) when the Hub is not already listing volumes
  const gp2 = ctx.find(EC2ANY, /^EBS:VolumeUsage\.gp2/);
  if (gp2.cost > 25 && !hubHas(/EbsVolume/, /Upgrade/)) {
    const gp2Vols = res?.volumes.filter((v) => v.type === 'gp2') ?? [];
    add({
      id: 'gp2-gp3',
      category: 'modernize',
      title: 'Move EBS volumes from gp2 to gp3',
      summary: `You spend ${money(gp2.cost)}/month on gp2 volumes. gp3 is 20% cheaper per GB with equal or better baseline performance, and the change happens online with no downtime.`,
      monthlySavings: gp2.cost * 0.2,
      confidence: 'high',
      effort: 'low',
      risk: 'low',
      service: svcOf(gp2.leaves),
      source: 'CloudPennies',
      evidence: [
        { label: 'gp2 storage', value: `${Math.round(gp2.usage).toLocaleString()} GB-months` },
        { label: 'gp2 spend, last 30 days', value: money(gp2.cost) },
      ],
      resources: gp2Vols.sort((a, b) => b.sizeGb - a.sizeGb).slice(0, 25).map((v) => ({ id: v.name ? `${v.name} (${v.id})` : v.id, detail: `${v.sizeGb} GB · ${v.region}`, monthlySavings: v.sizeGb * 0.02 })),
      steps: ['`aws ec2 modify-volume --volume-id <id> --volume-type gp3` — or select volumes in the console and choose Modify.', 'Volumes over 1 TB: set gp3 IOPS to 3 × size in GB (up to 16,000) to match gp2.'],
      thread: thread('gp2 volumes', svcOf(gp2.leaves), utOf(gp2.leaves)),
    });
  }

  // Unattached volumes (resource scan)
  const unattached = res?.volumes.filter((v) => !v.attached) ?? [];
  if (unattached.length && !hubHas(/EbsVolume/, /Delete/)) {
    const cost = (v: (typeof unattached)[0]) => v.sizeGb * (EBS_PRICE[v.type] ?? 0.1);
    add({
      id: 'ebs-unattached',
      category: 'idle',
      title: `${unattached.length} EBS ${unattached.length === 1 ? 'volume is' : 'volumes are'} attached to nothing`,
      summary: `${sum(unattached.map((v) => v.sizeGb)).toLocaleString()} GB of disks are sitting in the "available" state — usually left behind when an instance was terminated. They bill at full price.`,
      monthlySavings: sum(unattached.map(cost)),
      confidence: 'high',
      effort: 'low',
      risk: 'low',
      service: 'EC2 - Other',
      source: 'Resource scan',
      evidence: [{ label: 'Unattached storage', value: `${sum(unattached.map((v) => v.sizeGb)).toLocaleString()} GB` }],
      resources: unattached.sort((a, b) => cost(b) - cost(a)).slice(0, 30).map((v) => ({ id: v.name ? `${v.name} (${v.id})` : v.id, detail: `${v.sizeGb} GB ${v.type} · ${v.region}${v.createdAt ? ` · created ${fmtDateLong(v.createdAt)}` : ''}`, monthlySavings: cost(v) })),
      steps: ['Snapshot any volume you are unsure about (snapshots cost about half as much and only store used blocks).', 'Delete the volume.'],
      thread: thread('EBS storage', 'EC2 - Other', undefined),
    });
  }

  // Snapshots
  const snaps = ctx.find(EC2ANY, /^EBS:SnapshotUsage/);
  if (snaps.cost > 100) {
    const old = res?.oldSnapshots;
    add({
      id: 'ebs-snapshots',
      category: 'storage',
      title: 'EBS snapshots are piling up',
      summary: `Snapshots cost ${money(snaps.cost)}/month${snaps.prev > 0 && snaps.cost > snaps.prev * 1.02 ? ` and grew ${pct(((snaps.cost - snaps.prev) / snaps.prev) * 100)} in a month` : ''}.${old?.count ? ` ${old.count.toLocaleString()} of them are more than a year old.` : ' Steady growth usually means nothing ever deletes them.'}`,
      monthlySavings: snaps.cost * 0.4,
      confidence: 'low',
      effort: 'medium',
      risk: 'low',
      service: svcOf(snaps.leaves),
      source: old?.count ? 'Resource scan' : 'CloudPennies',
      evidence: [
        { label: 'Snapshot spend, last 30 days', value: money(snaps.cost) },
        ...(old?.count ? [{ label: 'Older than one year', value: `${old.count.toLocaleString()} snapshots (${old.totalGb.toLocaleString()} GB of source volumes)` }] : []),
        { label: 'Savings estimate', value: 'Assumes ~40% is expired backups; actual depends on retention needs' },
      ],
      steps: ['Set a retention rule with Amazon Data Lifecycle Manager or AWS Backup so old snapshots expire automatically.', 'Delete snapshots of volumes and AMIs that no longer exist.', 'Move compliance snapshots you must keep to the Archive tier (75% cheaper).'],
      thread: thread('EBS snapshots', svcOf(snaps.leaves), utOf(snaps.leaves)),
    });
  }

  // CloudWatch: log ingestion
  const ingest = ctx.find(CW, /^(DataProcessing(IA)?-Bytes|VendedLog(IA)?-Bytes)/);
  if (ingest.cost > 150) {
    const an = anomalies.find((a) => CW.test(a.service) && a.ongoing && a.causes.some((c) => /ingestion/i.test(c.label)));
    add({
      id: 'cw-log-ingest',
      category: 'observability',
      title: an ? 'Log ingestion has surged — something is logging far more than usual' : 'CloudWatch log ingestion is a major cost',
      summary: `You pay $0.50 for every GB of logs sent to CloudWatch — ${money(ingest.cost)} in the last 30 days for about ${Math.round(ingest.usage).toLocaleString()} GB.${an ? ` Ingestion jumped on ${fmtDateLong(an.start)}: typically debug logging left on, or an error loop.` : ' Ingestion, not storage, is usually the bulk of a CloudWatch bill.'}`,
      monthlySavings: an ? Math.max(an.monthlyRunRate, ingest.cost * 0.3) : ingest.cost * 0.3,
      confidence: an ? 'medium' : 'low',
      effort: 'medium',
      risk: 'low',
      service: svcOf(ingest.leaves),
      source: 'CloudPennies',
      urgent: !!an,
      evidence: [
        { label: 'Ingested, last 30 days', value: `${Math.round(ingest.usage).toLocaleString()} GB` },
        { label: 'Ingestion cost', value: money(ingest.cost) },
        ...(ingest.prev > 0 ? [{ label: 'vs previous 30 days', value: pct(((ingest.cost - ingest.prev) / ingest.prev) * 100, 0, true) }] : []),
      ],
      steps: [
        'Find the noisy log groups: CloudWatch → Logs → Log groups, sort by "Incoming bytes" (or the IncomingBytes metric by LogGroupName).',
        'Turn the log level down from DEBUG to INFO/WARN in production, and sample high-volume access logs.',
        'For logs you keep only for occasional troubleshooting, use the Infrequent Access log class — half the ingestion price.',
        'Send bulky audit logs (VPC flow logs, ALB logs) straight to S3 instead of CloudWatch.',
      ],
      thread: thread('Log ingestion', svcOf(ingest.leaves), utOf(ingest.leaves)),
    });
  }

  // CloudWatch: log retention
  const logStore = ctx.find(CW, /^TimedStorage-ByteHrs/);
  const neverExpire = res?.logGroups.filter((g) => g.retentionDays === null && g.storedBytes > 1024 ** 3) ?? [];
  if (neverExpire.length) {
    const gb = sum(neverExpire.map((g) => g.storedBytes)) / 1024 ** 3;
    const cost = gb * 0.03;
    if (cost > 5)
      add({
        id: 'cw-log-retention',
        category: 'observability',
        title: `${neverExpire.length} log groups keep logs forever`,
        summary: `These log groups have retention set to "Never expire" and now hold ${bytes(gb * 1024 ** 3)}. You pay $0.03/GB every month for logs nobody will read, and the pile only grows.`,
        monthlySavings: cost * 0.7,
        confidence: 'medium',
        effort: 'low',
        risk: 'low',
        service: svcOf(logStore.leaves) ?? 'AmazonCloudWatch',
        source: 'Resource scan',
        evidence: [
          { label: 'Stored in never-expire groups', value: bytes(gb * 1024 ** 3) },
          { label: 'Storage cost of those groups', value: `${money(cost)}/month` },
          { label: 'Savings estimate', value: 'Assumes a 90-day retention removes ~70% of stored data' },
        ],
        resources: neverExpire.sort((a, b) => b.storedBytes - a.storedBytes).slice(0, 30).map((g) => ({ id: g.name, detail: `${bytes(g.storedBytes)} · ${g.region}`, monthlySavings: (g.storedBytes / 1024 ** 3) * 0.03 * 0.7 })),
        steps: ['Pick a retention period per group (30–90 days suits most application logs; export to S3 first if you need an archive).', '`aws logs put-retention-policy --log-group-name <name> --retention-in-days 90`', 'Set a default in your infrastructure templates so new log groups never start as "Never expire".'],
        thread: logStore.leaves.length ? thread('Log storage', svcOf(logStore.leaves), utOf(logStore.leaves)) : undefined,
      });
  } else if (!res && logStore.cost > 50 && logStore.prev > 0 && logStore.cost > logStore.prev * 1.03) {
    add({
      id: 'cw-log-retention',
      category: 'observability',
      title: 'Log storage only ever grows',
      summary: `CloudWatch log storage costs ${money(logStore.cost)}/month and grew ${pct(((logStore.cost - logStore.prev) / logStore.prev) * 100)} in a month. Storage that climbs steadily is the signature of log groups set to "Never expire".`,
      monthlySavings: logStore.cost * 0.5,
      confidence: 'low',
      effort: 'low',
      risk: 'low',
      service: svcOf(logStore.leaves),
      source: 'CloudPennies',
      evidence: [
        { label: 'Stored', value: `${Math.round(logStore.usage).toLocaleString()} GB-months` },
        { label: 'Tip', value: 'Enable the resource scan in Settings to list the exact log groups' },
      ],
      steps: ['CloudWatch → Logs → Log groups: sort by "Retention" and look for "Never expire".', 'Set a retention policy (30–90 days) on each.'],
      thread: thread('Log storage', svcOf(logStore.leaves), utOf(logStore.leaves)),
    });
  }

  // CloudWatch: dashboards nobody opens
  const dashCost = ctx.find(CW, /^DashboardsUsageHour/);
  if (res?.dashboards.length) {
    const known = res.dashboards.filter((d) => d.lastViewed !== undefined);
    const unused = known.filter((d) => d.lastViewed === null);
    if (unused.length) {
      const billable = Math.max(0, res.dashboards.length - 3);
      const saved = Math.min(unused.length, billable) * 3;
      add({
        id: 'cw-dashboards',
        category: 'observability',
        title: `${unused.length} of ${res.dashboards.length} CloudWatch dashboards have not been opened in 90 days`,
        summary: `Each custom dashboard costs $3/month. CloudTrail shows nobody has viewed ${unused.length === 1 ? 'this one' : 'these'} in at least 90 days. Small money — but it is also a sign of metrics and alarms that were built for projects that ended.`,
        monthlySavings: saved,
        confidence: 'high',
        effort: 'low',
        risk: 'low',
        service: svcOf(dashCost.leaves) ?? 'AmazonCloudWatch',
        source: 'Resource scan',
        evidence: [
          { label: 'Dashboards', value: `${res.dashboards.length} total, ${unused.length} unviewed` },
          { label: 'How we know', value: 'No GetDashboard events in CloudTrail over the last 90 days' },
        ],
        resources: unused.slice(0, 40).map((d) => ({ id: d.name, detail: `${d.region}${d.lastModified ? ` · last edited ${fmtDateLong(d.lastModified)}` : ''}`, monthlySavings: 3 })),
        steps: ['Delete dashboards that belonged to finished projects, incidents and experiments.', 'While you are there, check whether the custom metrics and alarms that fed them are still needed — those usually cost far more than the dashboard.'],
        thread: dashCost.leaves.length ? thread('Dashboards', svcOf(dashCost.leaves), utOf(dashCost.leaves)) : undefined,
      });
    }
  }

  // CloudWatch: alarms that can never fire
  if (res && res.alarms.insufficientData * 0.1 >= 5) {
    add({
      id: 'cw-alarms',
      category: 'observability',
      title: `${res.alarms.insufficientData} alarms are watching metrics that no longer exist`,
      summary: `These alarms sit in INSUFFICIENT_DATA — their metric stopped reporting, usually because the resource was deleted. Each still costs $0.10/month, and they clutter the list on-call engineers rely on.`,
      monthlySavings: res.alarms.insufficientData * 0.1,
      confidence: 'medium',
      effort: 'low',
      risk: 'low',
      service: 'AmazonCloudWatch',
      source: 'Resource scan',
      evidence: [
        { label: 'Alarms', value: `${res.alarms.total.toLocaleString()} total` },
        { label: 'In INSUFFICIENT_DATA', value: String(res.alarms.insufficientData) },
        { label: 'With no action configured', value: String(res.alarms.noActions) },
      ],
      steps: ['CloudWatch → Alarms → filter by state "Insufficient data".', 'Delete the ones whose resource no longer exists.'],
    });
  }

  // CloudWatch: GetMetricData polling
  const gmd = ctx.find(CW, /^CW:(GMD|Requests)/);
  if (gmd.cost > 150) {
    add({
      id: 'cw-gmd',
      category: 'observability',
      title: 'A monitoring tool is pulling CloudWatch metrics at a high rate',
      summary: `${money(gmd.cost)}/month goes to CloudWatch API calls (GetMetricData). This is almost always a third-party monitoring integration (Datadog, Grafana, New Relic…) polling every metric in every region, including ones nobody charts.`,
      monthlySavings: gmd.cost * 0.4,
      confidence: 'low',
      effort: 'medium',
      risk: 'low',
      service: svcOf(gmd.leaves),
      source: 'CloudPennies',
      evidence: [
        { label: 'Metrics API cost, last 30 days', value: money(gmd.cost) },
        { label: 'Savings estimate', value: 'Assumes ~40% of polled namespaces/regions are not needed' },
      ],
      steps: ['In the monitoring tool\'s AWS integration, limit collection to the namespaces and regions you actually use.', 'Or switch the integration to CloudWatch Metric Streams, which is cheaper at high volume.', 'CloudTrail → Event history → GetMetricData shows which role is making the calls.'],
      thread: thread('Metrics API', svcOf(gmd.leaves), utOf(gmd.leaves)),
    });
  }

  // CloudWatch: custom metrics
  const metrics = ctx.find(CW, /^CW:MetricMonitorUsage/);
  if (metrics.cost > 300) {
    add({
      id: 'cw-metrics',
      category: 'observability',
      title: `About ${Math.round(metrics.usage).toLocaleString()} custom metrics are being billed`,
      summary: `Custom metrics cost up to $0.30 each per month — ${money(metrics.cost)} in total. High-cardinality dimensions (a metric per container, per customer, per URL) and detailed monitoring multiply the count quickly.`,
      monthlySavings: metrics.cost * 0.25,
      confidence: 'low',
      effort: 'medium',
      risk: 'low',
      service: svcOf(metrics.leaves),
      source: 'CloudPennies',
      evidence: [
        { label: 'Custom metric cost, last 30 days', value: money(metrics.cost) },
        { label: 'Savings estimate', value: 'Assumes a quarter can be dropped or aggregated' },
      ],
      steps: ['CloudWatch → Metrics → All metrics: look for namespaces with thousands of metrics.', 'Remove per-instance/per-pod dimensions you never filter by; turn off EC2 detailed monitoring and Container Insights where you do not use them.'],
      thread: thread('Custom metrics', svcOf(metrics.leaves), utOf(metrics.leaves)),
    });
  }

  // NAT gateway data processing
  const nat = ctx.find(null, /^NatGateway-Bytes/);
  if (nat.cost > 100) {
    add({
      id: 'nat-bytes',
      category: 'network',
      title: 'NAT Gateways are processing a lot of traffic',
      summary: `Every GB that leaves a private subnet through a NAT Gateway costs $0.045 on top of normal transfer — ${money(nat.cost)}/month for about ${Math.round(nat.usage).toLocaleString()} GB. Much of this is usually traffic to AWS's own services (S3, ECR, DynamoDB, CloudWatch) that could bypass the NAT entirely.`,
      monthlySavings: nat.cost * 0.35,
      confidence: 'low',
      effort: 'medium',
      risk: 'low',
      service: svcOf(nat.leaves),
      source: 'CloudPennies',
      evidence: [
        { label: 'Data processed, last 30 days', value: `${Math.round(nat.usage).toLocaleString()} GB` },
        { label: 'Processing cost', value: money(nat.cost) },
        { label: 'Savings estimate', value: 'Assumes ~35% of NAT traffic is to S3/DynamoDB/ECR' },
      ],
      steps: ['Add free gateway VPC endpoints for S3 and DynamoDB to every VPC with a NAT.', 'Add interface endpoints for ECR, CloudWatch Logs and other chatty AWS APIs where volume justifies $7/month each.', 'Use VPC Flow Logs (or CloudWatch NAT metrics by destination) to find the top talkers.'],
      thread: thread('NAT data processing', svcOf(nat.leaves), utOf(nat.leaves)),
    });
  }

  // Cross-AZ transfer
  const xaz = ctx.find(null, /^DataTransfer-(Regional-Bytes|xAZ)/);
  if (xaz.cost > 200) {
    add({
      id: 'cross-az',
      category: 'network',
      title: 'Paying for traffic between Availability Zones',
      summary: `${money(xaz.cost)}/month is data moving between AZs inside a region, billed at $0.01/GB in each direction. Chatty services, cross-AZ load balancing and database replicas in a different zone from their clients are the usual sources.`,
      monthlySavings: xaz.cost * 0.25,
      confidence: 'low',
      effort: 'high',
      risk: 'medium',
      service: svcOf(xaz.leaves),
      source: 'CloudPennies',
      evidence: [
        { label: 'Cross-AZ volume, last 30 days', value: `${Math.round(xaz.usage).toLocaleString()} GB` },
        { label: 'Savings estimate', value: 'Assumes a quarter can be kept zone-local' },
      ],
      steps: ['Enable topology-aware routing (Kubernetes) or AZ-affinity so services prefer same-zone peers.', 'Check that caches and read replicas are used from the same AZ as their clients.'],
      thread: thread('Cross-AZ transfer', svcOf(xaz.leaves), utOf(xaz.leaves)),
    });
  }

  // S3 storage class
  const s3std = ctx.find(/Simple Storage/, /^TimedStorage-ByteHrs/);
  const s3tiered = ctx.find(/Simple Storage/, /^TimedStorage-(SIA|ZIA|INT|Glacier|GIR|GDA)/);
  if (s3std.cost > 500 && s3tiered.cost < s3std.cost * 0.1) {
    add({
      id: 's3-tiering',
      category: 'storage',
      title: 'Almost all S3 data sits in the most expensive storage class',
      summary: `${money(s3std.cost)}/month is S3 Standard and barely anything uses cheaper tiers. Most data is rarely read after its first month; Intelligent-Tiering moves it automatically to tiers that cost 40–68% less, with no retrieval fees.`,
      monthlySavings: s3std.cost * 0.25,
      confidence: 'low',
      effort: 'low',
      risk: 'low',
      service: svcOf(s3std.leaves),
      source: 'CloudPennies',
      evidence: [
        { label: 'S3 Standard, last 30 days', value: `${money(s3std.cost)} (${Math.round(s3std.usage).toLocaleString()} GB-months)` },
        { label: 'In cheaper tiers', value: money(s3tiered.cost) },
        { label: 'Savings estimate', value: 'Assumes roughly half the data is cold; S3 Storage Lens will give the real figure' },
      ],
      steps: ['Add a lifecycle rule on your largest buckets: transition to Intelligent-Tiering after 0 days.', 'In the same rule, expire noncurrent versions and abort incomplete multipart uploads after 7 days — both are invisible storage.', 'S3 → Storage Lens shows which buckets hold the most data and how often it is read.'],
      thread: thread('S3 Standard storage', svcOf(s3std.leaves), utOf(s3std.leaves), 'LINKED_ACCOUNT'),
    });
  }

  // Old-generation EC2
  const oldGen = ctx.leaves.filter((l) => {
    if (!EC2ANY.test(l.service) || !/^BoxUsage/.test(l.u)) return false;
    const fam = instanceFamily(usageInstanceType(l.usageType) ?? '');
    return !!fam && fam in OLD_GEN && l.cost30 > 1;
  });
  const oldCost = sum(oldGen.map((l) => l.cost30));
  if (oldCost > 100) {
    const fams = [...new Set(oldGen.map((l) => instanceFamily(usageInstanceType(l.usageType)!)!))];
    add({
      id: 'old-gen-ec2',
      category: 'modernize',
      title: `Still running previous-generation instances (${joinList(fams.slice(0, 3))})`,
      summary: `${money(oldCost)}/month goes to instance families AWS replaced years ago. Current generations (${joinList([...new Set(fams.map((f) => OLD_GEN[f]))].slice(0, 3))}) deliver more performance for a lower hourly price.`,
      monthlySavings: oldCost * 0.1,
      confidence: 'low',
      effort: 'medium',
      risk: 'medium',
      service: svcOf(oldGen),
      source: 'CloudPennies',
      evidence: [
        { label: 'Old-generation spend, last 30 days', value: money(oldCost) },
        { label: 'Savings estimate', value: 'About 10% from price alone; more if the faster CPU lets you drop a size' },
      ],
      steps: ['Stop the instance, change the type to the current generation, start it. Nitro-based types need ENA and NVMe drivers (present in any OS image from the last several years).'],
      thread: thread('Old-generation instances', svcOf(oldGen), utOf(oldGen)),
    });
  }

  // Graviton for managed services
  const gravCands = ctx.leaves.filter((l) => {
    if (!/Relational Database|ElastiCache|OpenSearch|MemoryDB/.test(l.service)) return false;
    if (/Relational Database/.test(l.service) && hubHas(/Rds/, /Graviton/)) return false;
    const it = usageInstanceType(l.usageType);
    if (!it || /^HeavyUsage/.test(l.u)) return false;
    const fam = instanceFamily(it);
    return !!fam && fam in GRAVITON_EQUIV && l.cost30 > 1;
  });
  const gravCost = sum(gravCands.map((l) => l.cost30));
  if (gravCost > 300) {
    const svcs = [...new Set(gravCands.map((l) => shortService(l.service)))];
    add({
      id: 'graviton-managed',
      category: 'modernize',
      title: `Switch ${joinList(svcs)} nodes to Graviton`,
      summary: `${money(gravCost)}/month runs on Intel-based node types in managed services. The Graviton equivalents are priced roughly 10% lower, and because AWS runs the software there is nothing to recompile — it is a node-type change.`,
      monthlySavings: gravCost * 0.1,
      confidence: 'medium',
      effort: 'low',
      risk: 'low',
      source: 'CloudPennies',
      evidence: gravCands
        .sort((a, b) => b.cost30 - a.cost30)
        .slice(0, 5)
        .map((l) => {
          const it = usageInstanceType(l.usageType)!;
          const fam = instanceFamily(it)!;
          return { label: `${shortService(l.service)} · ${it}`, value: `${money(l.cost30)}/month → ${it.replace(fam + '.', GRAVITON_EQUIV[fam] + '.')}` };
        }),
      steps: ['Modify the node/instance class to the Graviton equivalent in a maintenance window (Multi-AZ setups fail over with seconds of interruption).', 'Do this before buying reservations, since reservations are tied to the instance family.'],
      thread: thread(svcs[0], svcOf(gravCands), svcs.length === 1 ? utOf(gravCands) : undefined),
    });
  }

  // Idle load balancers (resource scan)
  const idleLbs = res?.loadBalancers.filter((l) => l.targets === 0) ?? [];
  if (idleLbs.length) {
    add({
      id: 'idle-lb',
      category: 'idle',
      title: `${idleLbs.length} load ${idleLbs.length === 1 ? 'balancer has' : 'balancers have'} no targets`,
      summary: `A load balancer with nothing registered behind it cannot serve traffic, but it still bills about ${money(0.0225 * HOURS, { cents: true })}/month plus a public IP per zone.`,
      monthlySavings: idleLbs.length * (0.0225 * HOURS + 2 * 0.005 * HOURS),
      confidence: 'high',
      effort: 'low',
      risk: 'low',
      service: 'Amazon Elastic Load Balancing',
      source: 'Resource scan',
      evidence: [{ label: 'Load balancers with zero registered targets', value: String(idleLbs.length) }],
      resources: idleLbs.slice(0, 30).map((l) => ({ id: l.name, detail: `${l.type} · ${l.region}${l.createdAt ? ` · created ${fmtDateLong(l.createdAt)}` : ''}`, monthlySavings: 0.0225 * HOURS + 2 * 0.005 * HOURS })),
      steps: ['Check DNS: make sure no record still points at the load balancer.', 'Delete it, along with its empty target groups.'],
      thread: thread('Load Balancing', 'Amazon Elastic Load Balancing'),
    });
  }

  // Long-stopped instances still paying for disks
  const stopped = (res?.stoppedInstances ?? []).filter((s) => s.ebsGb > 0 && (!s.stoppedSince || diffDays(today, s.stoppedSince) > 30));
  if (stopped.length) {
    const gb = sum(stopped.map((s) => s.ebsGb));
    add({
      id: 'stopped-instances',
      category: 'idle',
      title: `${stopped.length} stopped ${stopped.length === 1 ? 'instance is' : 'instances are'} still paying for disks`,
      summary: `Stopped instances cost nothing for compute, but their ${gb.toLocaleString()} GB of attached EBS volumes bill every month. ${stopped.length === 1 ? 'This one has' : 'These have'} been stopped for more than 30 days.`,
      monthlySavings: gb * 0.09,
      confidence: 'medium',
      effort: 'low',
      risk: 'low',
      service: 'EC2 - Other',
      source: 'Resource scan',
      evidence: [{ label: 'Attached storage', value: `${gb.toLocaleString()} GB` }],
      resources: stopped.map((s) => ({ id: s.name ? `${s.name} (${s.id})` : s.id, detail: `${s.type} · ${s.ebsGb} GB${s.stoppedSince ? ` · stopped since ${fmtDateLong(s.stoppedSince)}` : ''} · ${s.region}`, monthlySavings: s.ebsGb * 0.09 })),
      steps: ['Create an AMI if the machine might be needed again (snapshots are cheaper than volumes), then terminate.'],
    });
  }

  // Duplicate CloudTrail trails
  const trail = ctx.find(/CloudTrail/, /PaidEventsRecorded/);
  if (trail.cost > 20) {
    add({
      id: 'cloudtrail-dup',
      category: 'governance',
      title: 'Paying for duplicate CloudTrail trails',
      summary: `The first copy of management events is free. ${money(trail.cost)}/month in "paid events recorded" means more than one trail is capturing the same events — often an old account-level trail left running alongside an organization trail.`,
      monthlySavings: trail.cost,
      confidence: 'high',
      effort: 'low',
      risk: 'medium',
      service: svcOf(trail.leaves),
      source: 'CloudPennies',
      evidence: [{ label: 'Paid management events, last 30 days', value: `${Math.round(trail.usage).toLocaleString()} events · ${money(trail.cost)}` }],
      steps: ['CloudTrail → Trails: list trails in each account and region.', 'Keep the organization (or single multi-region) trail; delete the redundant ones after confirming with security.'],
      thread: thread('CloudTrail', svcOf(trail.leaves), utOf(trail.leaves), 'LINKED_ACCOUNT'),
    });
  }

  // AWS Config
  const cfg = ctx.find(/Config/, /ConfigurationItemRecorded/);
  if (cfg.cost > 150) {
    add({
      id: 'config-recording',
      category: 'governance',
      title: 'AWS Config is recording a high volume of changes',
      summary: `${money(cfg.cost)}/month for ${Math.round(cfg.usage).toLocaleString()} configuration items. Short-lived resources (containers' network interfaces, autoscaled instances) generate a record on every change and usually dominate this bill.`,
      monthlySavings: cfg.cost * 0.4,
      confidence: 'low',
      effort: 'low',
      risk: 'low',
      service: svcOf(cfg.leaves),
      source: 'CloudPennies',
      evidence: [
        { label: 'Items recorded, last 30 days', value: Math.round(cfg.usage).toLocaleString() },
        { label: 'Savings estimate', value: 'Assumes ~40% comes from churny resource types' },
      ],
      steps: ['Switch high-churn resource types (e.g. AWS::EC2::NetworkInterface) to daily "periodic" recording, or exclude them.', 'Config → Settings → Recording frequency. Use the Config usage metrics in CloudWatch to see which types record the most.'],
      thread: thread('Config', svcOf(cfg.leaves), utOf(cfg.leaves), 'LINKED_ACCOUNT'),
    });
  }

  // Lambda on x86
  const lambdaX86 = ctx.find(/Lambda/, /^Lambda-GB-Second(?!-ARM)/);
  if (lambdaX86.cost > 300) {
    add({
      id: 'lambda-arm',
      category: 'modernize',
      title: 'Run Lambda functions on Arm',
      summary: `${money(lambdaX86.cost)}/month of Lambda compute runs on x86. The Arm (Graviton) architecture is 20% cheaper per GB-second and works unchanged for most Node.js, Python and Java functions.`,
      monthlySavings: lambdaX86.cost * 0.2,
      confidence: 'medium',
      effort: 'medium',
      risk: 'low',
      service: svcOf(lambdaX86.leaves),
      source: 'CloudPennies',
      evidence: [{ label: 'x86 Lambda compute, last 30 days', value: money(lambdaX86.cost) }],
      steps: ['Set `Architectures: [arm64]` on functions without native x86 dependencies and redeploy.', 'Start with the highest-duration functions (Lambda → Functions, sort by duration in CloudWatch).'],
      thread: thread('Lambda compute', svcOf(lambdaX86.leaves), utOf(lambdaX86.leaves)),
    });
  }

  // Unused capacity reservations
  const unusedCr = ctx.find(EC2ANY, /^(UnusedBox|UnusedDed):/);
  if (unusedCr.cost > 20) {
    add({
      id: 'unused-capacity-reservation',
      category: 'idle',
      title: 'Capacity reservations with nothing running in them',
      summary: `On-Demand Capacity Reservations bill at the full instance price whether or not an instance is using them. ${money(unusedCr.cost)} in the last 30 days was for reserved capacity that sat empty.`,
      monthlySavings: unusedCr.cost,
      confidence: 'high',
      effort: 'low',
      risk: 'medium',
      service: svcOf(unusedCr.leaves),
      source: 'CloudPennies',
      evidence: [{ label: 'Unused reservation hours', value: Math.round(unusedCr.usage).toLocaleString() }],
      steps: ['EC2 → Capacity Reservations: cancel or shrink reservations whose "Available" count stays above zero.'],
      thread: thread('Unused capacity', svcOf(unusedCr.leaves), utOf(unusedCr.leaves)),
    });
  }

  // T-family unlimited credits
  const credits = ctx.find(EC2ANY, /^CPUCredits:/);
  if (credits.cost > 30) {
    add({
      id: 'cpu-credits',
      category: 'rightsizing',
      title: 'Burstable instances are running past their baseline',
      summary: `${money(credits.cost)}/month in surplus CPU credits means T-family instances in "unlimited" mode are busy all the time. Past a point, a fixed-performance instance (m or c family) is cheaper than paying for credits.`,
      monthlySavings: credits.cost * 0.5,
      confidence: 'low',
      effort: 'medium',
      risk: 'low',
      service: svcOf(credits.leaves),
      source: 'CloudPennies',
      evidence: [{ label: 'CPU credit charges, last 30 days', value: money(credits.cost) }],
      steps: ['Find the instances with CPUSurplusCreditsCharged > 0 in CloudWatch.', 'Move them to the next T size up or to an m/c-family type.'],
      thread: thread('CPU credits', svcOf(credits.leaves), utOf(credits.leaves)),
    });
  }

  // Untagged spend
  if (tags && tags.untaggedPct > 15 && tags.untaggedCost > 100) {
    add({
      id: 'untagged',
      category: 'governance',
      title: `${pct(tags.untaggedPct)} of spend has no "${tags.key}" tag`,
      summary: `${money(tags.untaggedCost)} in the last 30 days cannot be attributed to an owner. Untagged spend is where waste hides, because nobody is accountable for it.`,
      monthlySavings: 0,
      confidence: 'high',
      effort: 'medium',
      risk: 'low',
      source: 'CloudPennies',
      evidence: tags.values.slice(0, 5).map((v) => ({ label: v.value || '(untagged)', value: money(v.cost) })),
      steps: ['Pull the thread to see which services make up the untagged spend, and tag the biggest ones first.', 'Enforce the tag on new resources with a tag policy or in your infrastructure templates.', 'Some charges (data transfer, support, tax) cannot be tagged — expect a floor of a few percent.'],
      thread: { label: `Untagged (${tags.key})`, filters: { [`TAG:${tags.key}`]: [''] } as Partial<Record<Dim, string[]>>, groupBy: 'SERVICE' },
    });
  }

  // Order: urgent first, then by savings
  out.sort((a, b) => Number(!!b.urgent) - Number(!!a.urgent) || b.monthlySavings - a.monthlySavings);
  return out;
}

function accountName(ctx: Ctx, id?: string): string | undefined {
  if (!id) return undefined;
  return ctx.snap.accounts.find((a) => a.id === id)?.name ?? id;
}
