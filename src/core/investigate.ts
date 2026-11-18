// Builds a prompt the user can paste into Claude Code (or any agent with the AWS CLI)
// to find the root cause of an anomaly. The prompt is strictly diagnostic: it tells the
// agent to read and never to change anything. A prompt is not a security boundary, so
// it also tells the agent to verify — and the user to supply — read-only credentials.

import { describeUsage, shortService, stripRegion } from './catalog';
import type { Anomaly, Snapshot } from './types';
import { addDays, fmtDateLong, money } from './util';

interface Playbook {
  test: RegExp;
  steps: (ctx: { start: string; end: string }) => string[];
}

// Matched against "<service> | <cause labels> | <usage types>". First matches win; several can apply.
const PLAYBOOKS: Playbook[] = [
  {
    test: /log ingestion|DataProcessing-Bytes|VendedLog/i,
    steps: ({ start }) => [
      'Find which log groups are ingesting the most. For each affected region, list groups with `aws logs describe-log-groups` and pull the `IncomingBytes` metric (namespace `AWS/Logs`, dimension `LogGroupName`, daily Sum) for the window before and during the anomaly with `aws cloudwatch get-metric-data`. Rank log groups by the increase.',
      `For the top one or two log groups, sample what is being written during the anomaly: \`aws logs filter-log-events --log-group-name <name> --start-time <ms> --end-time <ms> --limit 50\`. Look for DEBUG/TRACE lines, a repeating error or stack trace, or a retry loop. Do not use Logs Insights queries — they are billed per GB scanned.`,
      `Find what changed around ${start}: a deployment, a log-level change, a new service. Check CloudTrail for \`UpdateFunctionConfiguration\`, \`UpdateService\`, \`RegisterTaskDefinition\`, \`PutParameter\`, \`CreateLogGroup\` between ${addDays(start, -2)} and ${addDays(start, 1)}.`,
      `If the charge is vended logs (VPC flow logs, Route 53 resolver, API Gateway, etc.), list flow logs with \`aws ec2 describe-flow-logs\` and check creation times against ${start}.`,
    ],
  },
  {
    test: /log storage|TimedStorage-ByteHrs.*CloudWatch|CloudWatch.*TimedStorage/i,
    steps: () => ['List log groups with `aws logs describe-log-groups` and sort by `storedBytes`. Report the largest, their `retentionInDays` (missing = never expire), and which grew most.'],
  },
  {
    test: /custom metrics|MetricMonitorUsage|GMD|GetMetricData|CW:Requests/i,
    steps: ({ start }) => [
      'Count metrics per namespace with `aws cloudwatch list-metrics --namespace <ns>` (paginate) and report which namespaces hold the most metrics and which dimensions make them high-cardinality.',
      `For API-call charges, find the caller: \`aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=GetMetricData\` around ${start}; group by \`userIdentity.arn\` and \`userAgent\`. A monitoring vendor's integration role is the usual answer.`,
    ],
  },
  {
    test: /NAT ?Gateway|NatGateway/i,
    steps: ({ start, end }) => [
      'List NAT gateways in the affected regions: `aws ec2 describe-nat-gateways`. For each, pull `BytesOutToDestination`, `BytesInFromDestination`, `BytesOutToSource` and `BytesInFromSource` (namespace `AWS/NATGateway`, dimension `NatGatewayId`, daily Sum) to find which gateway carried the extra traffic and in which direction.',
      `Identify what sent it. Check whether VPC Flow Logs exist (\`aws ec2 describe-flow-logs\`). If they go to CloudWatch Logs, sample them for the NAT's network interface during ${start}..${end} and rank source IPs by bytes; map the top source IPs to instances/ENIs with \`aws ec2 describe-network-interfaces --filters Name=addresses.private-ip-address,Values=<ip>\`.`,
      'Check whether the VPCs have gateway endpoints for S3 and DynamoDB and interface endpoints for ECR/CloudWatch (`aws ec2 describe-vpc-endpoints`). Traffic to those services through a NAT is the most common avoidable cause.',
      `Look for a batch job, image pull storm, backup or data migration that ran in that window (ECS/EKS task launches, Auto Scaling activity: \`aws autoscaling describe-scaling-activities\`).`,
    ],
  },
  {
    test: /Data transfer|DataTransfer|AWS-Out-Bytes|CloudFront-Out/i,
    steps: () => [
      'Break the charge down by `OPERATION` and by `REGION` in Cost Explorer to see which service is sending the data and where to (internet, another region, another AZ).',
      'For the top instances or load balancers in that region, compare `NetworkOut` (EC2) or `ProcessedBytes` (ELB) daily Sums before and during the anomaly to find the sender.',
    ],
  },
  {
    test: /Elastic Compute Cloud|BoxUsage|SpotUsage|instances\b/i,
    steps: ({ start }) => [
      `Find instances of the affected type that were launched around ${start}: \`aws ec2 describe-instances --filters Name=instance-type,Values=<type>\` in each affected region, and compare \`LaunchTime\` with the anomaly start. Report Name/owner tags, Auto Scaling group, and who launched them.`,
      `Find who or what launched them: \`aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RunInstances --start-time ${addDays(start, -2)} --end-time ${addDays(start, 2)}\`. Report the principal (user, role, or service such as autoscaling/EKS/Batch).`,
      'If an Auto Scaling group is involved, check `aws autoscaling describe-scaling-activities` and whether desired/min capacity was raised. If it is an EKS node group or Karpenter, say so.',
      'Check whether a Savings Plan or reservation expired at the same time — the same instances billed at on-demand rates look like a cost increase with no usage change.',
    ],
  },
  {
    test: /ExtendedSupport|Extended Support/i,
    steps: () => [
      'For RDS: `aws rds describe-db-instances` and `aws rds describe-db-clusters` in each region. List every instance with its `Engine`, `EngineVersion`, class, Multi-AZ flag, and whether the version is past standard support (MySQL 5.7, PostgreSQL 11/12 and older are the usual ones). Identify exactly which instances incur the surcharge.',
      'For EKS: `aws eks list-clusters` then `aws eks describe-cluster --name <n>`; report each cluster\'s `version` and `upgradePolicy.supportType`, and which are in extended support.',
      'Report available upgrade targets (`aws rds describe-db-engine-versions --engine <e> --engine-version <v> --query "DBEngineVersions[].ValidUpgradeTarget"`), but do not start an upgrade.',
    ],
  },
  {
    test: /Relational Database|InstanceUsage:db|Aurora|RDS/i,
    steps: ({ start }) => [
      `List DB instances and clusters (\`aws rds describe-db-instances\`, \`describe-db-clusters\`) and compare \`InstanceCreateTime\` with ${start}. Look for new instances, new read replicas, a class change, or a Multi-AZ conversion.`,
      `Check \`aws rds describe-events --source-type db-instance --duration 20160\` and CloudTrail for \`CreateDBInstance\`, \`ModifyDBInstance\`, \`CreateDBInstanceReadReplica\`, \`RestoreDBInstanceFromDBSnapshot\` around ${start}.`,
      'For Aurora I/O or storage charges, pull `VolumeReadIOPs`/`VolumeWriteIOPs`/`VolumeBytesUsed` per cluster to find the one that grew.',
    ],
  },
  {
    test: /Bedrock|InputTokenCount|OutputTokenCount|token/i,
    steps: ({ start }) => [
      'Pull Bedrock usage per model: namespace `AWS/Bedrock`, metrics `Invocations`, `InputTokenCount`, `OutputTokenCount`, dimension `ModelId`, daily Sum. Report which models account for the spend and how the daily volume is trending.',
      `Find who is calling: \`aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=bedrock.amazonaws.com\` from ${addDays(start, -1)}. Group by \`userIdentity.arn\` to name the application, role or person. Note that InvokeModel data events only appear if a trail records them.`,
      'Check whether model invocation logging is on (`aws bedrock get-model-invocation-logging-configuration`) and whether provisioned throughput exists (`aws bedrock list-provisioned-model-throughputs`).',
    ],
  },
  {
    test: /Simple Storage|S3|TimedStorage|Requests-Tier/i,
    steps: () => [
      'Find the bucket: for each bucket (`aws s3api list-buckets`), pull `BucketSizeBytes` (namespace `AWS/S3`, dimensions `BucketName` + `StorageType`, daily) and `NumberOfObjects`. Rank buckets by growth across the anomaly window.',
      'For the top bucket report versioning (`get-bucket-versioning`), lifecycle rules (`get-bucket-lifecycle-configuration`) and whether incomplete multipart uploads may be accumulating (`list-multipart-uploads --max-items 20`). Do not list or download object contents.',
      'For request charges, check whether request metrics exist; otherwise look in CloudTrail data events or S3 server access logs if they are enabled.',
    ],
  },
  {
    test: /Lambda/i,
    steps: ({ start }) => [
      'Rank functions by `Invocations` and `Duration` (namespace `AWS/Lambda`, dimension `FunctionName`, daily Sum) before vs during the anomaly. Report the function(s) that grew, their memory setting, and `Errors`/`Throttles` — a retry storm shows up as errors rising with invocations.',
      `Check what triggers the function (\`aws lambda list-event-source-mappings --function-name <f>\`, \`get-policy\`) and whether it was redeployed around ${start} (\`aws lambda list-versions-by-function\`, CloudTrail \`UpdateFunctionCode\`). Watch for a function that triggers itself.`,
    ],
  },
  {
    test: /DynamoDB/i,
    steps: () => ['Rank tables by `ConsumedReadCapacityUnits`/`ConsumedWriteCapacityUnits` (namespace `AWS/DynamoDB`, dimension `TableName`). Report billing mode and provisioned capacity per table (`aws dynamodb describe-table`), and whether a scan-heavy job, a new GSI or a backfill started.'],
  },
  {
    test: /Kubernetes|EKS|Container Service|Fargate/i,
    steps: ({ start }) => [
      'List clusters and services (`aws eks list-clusters`, `aws ecs list-clusters`, `list-services`, `describe-services`). Compare desired/running task counts and task sizes with before the anomaly; check `aws application-autoscaling describe-scaling-activities --service-namespace ecs`.',
      `Look for new clusters, node groups or services created around ${start} in CloudTrail (\`CreateCluster\`, \`CreateNodegroup\`, \`CreateService\`, \`UpdateService\`).`,
    ],
  },
];

const GENERIC = ({ start }: { start: string; end: string }): string[] => [
  'List the resources of this service in the affected regions with the relevant `describe-*`/`list-*` calls and look for anything created or resized near the anomaly start.',
  `Search CloudTrail for create/modify/scale events for this service between ${addDays(start, -2)} and ${addDays(start, 2)}: \`aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventSource,AttributeValue=<service>.amazonaws.com --start-time ... --end-time ...\`.`,
  'Pull the service\'s main usage metric from CloudWatch at daily granularity and line it up against the cost curve.',
];

export function investigationPrompt(a: Anomaly, snap: Snapshot): string {
  const svc = shortService(a.service);
  const usageTypes = a.causes.map((c) => c.key);
  const haystack = [a.service, ...a.causes.map((c) => c.label), ...usageTypes].join(' | ');
  const ctx = { start: a.start, end: a.end };
  const matched = PLAYBOOKS.filter((p) => p.test.test(haystack)).slice(0, 2);
  const steps = (matched.length ? matched.flatMap((p) => p.steps(ctx)) : GENERIC(ctx)).slice(0, 7);

  const ceEnd = addDays(a.end, 1);
  const ceStart = addDays(a.start, -14);
  const filterParts: string[] = [`{"Dimensions":{"Key":"SERVICE","Values":[${JSON.stringify(a.service)}]}}`];
  if (usageTypes.length) filterParts.push(`{"Dimensions":{"Key":"USAGE_TYPE","Values":${JSON.stringify(usageTypes)}}}`);
  filterParts.push('{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit","Refund"]}}}');
  const filter = `{"And":[${filterParts.join(',')}]}`;
  const ceCmd = (group: string) =>
    `aws ce get-cost-and-usage --time-period Start=${ceStart},End=${ceEnd} --granularity DAILY --metrics ${snap.meta.costBasis} UsageQuantity --group-by Type=DIMENSION,Key=${group} --filter '${filter}'`;

  const accounts = snap.accounts.length > 1 ? snap.accounts.map((x) => `${x.id} (${x.name})`).join(', ') : '';
  const kindText =
    a.kind === 'new'
      ? 'a service that was not on the bill before'
      : a.kind === 'shift'
        ? a.expectedDaily < 0.5
          ? 'a brand-new line item that started and kept running'
          : 'a step change — the cost moved to a higher level and stayed there'
        : a.ongoing
          ? 'a spike that is still elevated'
          : 'a spike that has since returned to normal';

  const L: string[] = [];
  L.push(`# Investigate an AWS cost anomaly: ${a.title}`);
  L.push('');
  L.push('You are investigating a cost anomaly in an AWS account using the AWS CLI. Your job is to find the root cause and explain it. **This is a read-only investigation.**');
  L.push('');
  L.push('## Hard rules — read these first');
  L.push('');
  L.push('1. **Never change anything.** Only run AWS CLI commands whose operation starts with `describe-`, `get-`, `list-`, `lookup-`, `filter-`, `batch-get-` or `search-`, plus `aws sts get-caller-identity`.');
  L.push('2. **Never run** any operation that creates, updates, deletes or acts: `create-*`, `put-*`, `update-*`, `modify-*`, `delete-*`, `remove-*`, `terminate-*`, `stop-*`, `start-*`, `reboot-*`, `run-*`, `attach-*`, `detach-*`, `associate-*`, `disassociate-*`, `tag-*`, `untag-*`, `set-*`, `enable-*`, `disable-*`, `register-*`, `deregister-*`, `invoke`, `send-*`, `publish`, `purchase-*`, `cancel-*`, `restore-*`, `copy-*`, `import-*`, `apply-*`, `execute-*`, `start-query*`. No `aws s3 cp/mv/rm/sync`. If you are unsure whether a command writes, do not run it.');
  L.push('3. **Do not fix the problem**, even if the fix is obvious and one command away. Describe the fix for a human to carry out.');
  L.push('4. **Do not read data contents**: no S3 object downloads, no secret or parameter values (`secretsmanager get-secret-value`, `ssm get-parameter --with-decryption`), no database queries. Configuration and metrics only. When sampling logs, redact anything that looks like a credential, token or personal data.');
  L.push('5. **Do not write files, install software, or change local AWS configuration or credentials.** Report your findings in the conversation.');
  L.push('6. **Mind the meter.** Each `aws ce` call costs $0.01 — make at most 10. Do not run CloudWatch Logs Insights or Athena queries (billed per GB scanned).');
  L.push('7. **First command:** `aws sts get-caller-identity`. State the account and identity you are using. If the identity appears to have write access (for example an admin role), say so and continue under the same rules — the rules above apply regardless of what the credentials allow.');
  L.push('8. If a command is denied, note the missing permission and move on. Do not attempt workarounds.');
  L.push('');
  L.push('## The anomaly');
  L.push('');
  L.push(`- **What:** ${a.summary}`);
  L.push(`- **Pattern:** ${kindText}.`);
  L.push(`- **Service (Cost Explorer name):** \`${a.service}\``);
  if (a.causes.length) {
    L.push('- **Billing line items responsible:**');
    for (const c of a.causes.slice(0, 6)) L.push(`  - \`${c.key}\` — ${describeUsage(a.service, c.key)}${a.causes.length > 1 ? ` (${money(c.impact)} of the excess)` : ''}`);
  }
  L.push(`- **Window:** ${fmtDateLong(a.start)} to ${fmtDateLong(a.end)}${a.ongoing ? ' — still running as of the last billing data' : ''}. Dates are UTC.`);
  if (a.kind !== 'new') L.push(`- **Daily cost:** normally about ${money(a.expectedDaily, { cents: true })}, about ${money(a.actualDaily, { cents: true })} during the anomaly.`);
  L.push(`- **Cost so far:** ${money(a.impact)}${a.ongoing && a.monthlyRunRate > 0 ? ` (about ${money(a.monthlyRunRate)} per month if it continues)` : ''}.`);
  L.push(`- **Account:** ${snap.meta.accountId}${accounts ? `. Linked accounts in this organization: ${accounts}. Billing data is visible from the management account, but resources live in the member accounts — say which account you need access to if the current credentials cannot see the resources.` : ''}`);
  const prefixes = [...new Set(usageTypes.map((u) => u.slice(0, u.length - stripRegion(u).length)).filter(Boolean))];
  if (prefixes.length) L.push(`- **Region hint:** the usage types carry the billing region prefix ${prefixes.map((p) => `\`${p.replace(/-$/, '')}\``).join(', ')}; a usage type with no prefix is usually us-east-1.`);
  L.push(`- **Cost basis:** ${snap.meta.costBasis}, credits and refunds excluded.`);
  L.push('');
  L.push('## How to investigate');
  L.push('');
  L.push('**Step 1 — Narrow down where.** Use Cost Explorer to split the affected line items by region, then by account, then by API operation. These three commands are ready to run (us-east-1 endpoint):');
  L.push('');
  for (const g of ['REGION', 'LINKED_ACCOUNT', 'OPERATION']) L.push('```bash', ceCmd(g), '```', '');
  L.push('If resource-level cost data is enabled on the account, `aws ce get-cost-and-usage-with-resources` (last 14 days only, grouped by `RESOURCE_ID`) will name the exact resource. Try it once; if it returns an opt-in error, move on.');
  L.push('');
  L.push(`**Step 2 — Find the resource and what changed.** In the region(s) and account(s) from step 1:`);
  L.push('');
  steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push('');
  L.push(`**Step 3 — Establish the trigger.** Pin down what happened on or just before ${fmtDateLong(a.start)}: a deployment, a configuration change, a scaling event, a new workload, or an expired discount. CloudTrail event history covers the last 90 days of management events: \`aws cloudtrail lookup-events --start-time ${addDays(a.start, -2)}T00:00:00Z --end-time ${addDays(a.start, 1)}T23:59:59Z\` with an \`EventName\`, \`EventSource\` or \`ResourceName\` lookup attribute. Name the principal behind the change.`);
  L.push('');
  L.push('**Step 4 — Check it adds up.** Confirm that the resource and change you found explain the size of the cost increase (usage quantity × unit price ≈ the extra dollars). If they explain only part of it, say how much and keep looking or say what remains unexplained.');
  L.push('');
  L.push('## What to report');
  L.push('');
  L.push('Finish with a short report in this shape:');
  L.push('');
  L.push('- **Root cause** — one or two sentences a non-engineer can follow.');
  L.push('- **Evidence** — the specific resources (IDs/ARNs, region, account), the metric or event that shows it, and the dates. Quote numbers.');
  L.push('- **Who or what triggered it** — the principal, pipeline or automated process, if you could determine it.');
  L.push(`- **Is it still happening?** — and the expected cost if nothing is done.`);
  L.push('- **Recommended fix** — concrete steps for a human, including the exact commands they would run, clearly labelled as *not executed*. Note any risk or downtime.');
  L.push('- **Confidence** — high, medium or low, and what would raise it.');
  L.push('- **Could not check** — anything blocked by permissions or missing data.');
  L.push('- **Commands run** — the list of AWS CLI commands you executed, to show nothing was modified.');
  L.push('');
  L.push(`_Prompt generated by CloudPennies for ${svc}, anomaly window ${a.start} to ${a.end}._`);
  return L.join('\n');
}
