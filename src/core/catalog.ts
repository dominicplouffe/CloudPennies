// Translates AWS billing vocabulary (service names, usage types) into plain English.
// Usage types are the most precise signal available from billing data alone, and
// nobody can read them. This is the dictionary.

const REGION_PREFIX = /^(?:(?:US|EU|AP|SA|CA|ME|AF|IL|MX|CN|UG)[A-Z]{0,3}\d?-)+/;

/** "USW2-BoxUsage:m5.large" -> "BoxUsage:m5.large" */
export function stripRegion(usageType: string): string {
  const s = usageType.replace(REGION_PREFIX, '');
  return s || usageType;
}

const SERVICE_SHORT: Record<string, string> = {
  'Amazon Elastic Compute Cloud - Compute': 'EC2 Instances',
  'EC2 - Other': 'EC2 Other (EBS, NAT, transfer)',
  'Amazon Relational Database Service': 'RDS',
  'Amazon Simple Storage Service': 'S3',
  AmazonCloudWatch: 'CloudWatch',
  'Amazon CloudWatch': 'CloudWatch',
  'Amazon Virtual Private Cloud': 'VPC',
  'AWS Lambda': 'Lambda',
  'Amazon DynamoDB': 'DynamoDB',
  'Amazon ElastiCache': 'ElastiCache',
  'Amazon Elastic Load Balancing': 'Load Balancing',
  'Elastic Load Balancing': 'Load Balancing',
  'AWS Key Management Service': 'KMS',
  'AWS CloudTrail': 'CloudTrail',
  'AWS Config': 'Config',
  'Amazon Elastic Container Service': 'ECS / Fargate',
  'Amazon Elastic Container Service for Kubernetes': 'EKS',
  'Amazon Elastic Kubernetes Service': 'EKS',
  'Amazon OpenSearch Service': 'OpenSearch',
  'Amazon CloudFront': 'CloudFront',
  'Amazon Route 53': 'Route 53',
  'AWS Secrets Manager': 'Secrets Manager',
  'Amazon Simple Queue Service': 'SQS',
  'Amazon Simple Notification Service': 'SNS',
  'Amazon Kinesis': 'Kinesis',
  'Amazon Kinesis Firehose': 'Firehose',
  'AWS Glue': 'Glue',
  'Amazon Athena': 'Athena',
  'Amazon Redshift': 'Redshift',
  'Amazon SageMaker': 'SageMaker',
  'Amazon Bedrock': 'Bedrock',
  'Amazon Elastic File System': 'EFS',
  'Amazon EC2 Container Registry (ECR)': 'ECR',
  'Amazon Elastic Container Registry': 'ECR',
  'AWS Data Transfer': 'Data Transfer',
  'AWS Support (Business)': 'Support (Business)',
  'AWS Support (Enterprise)': 'Support (Enterprise)',
  'AWS Support (Developer)': 'Support (Developer)',
  'Amazon GuardDuty': 'GuardDuty',
  'AWS WAF': 'WAF',
  'AWS Step Functions': 'Step Functions',
  'Amazon API Gateway': 'API Gateway',
  'Amazon Managed Streaming for Apache Kafka': 'MSK',
  'Amazon MemoryDB': 'MemoryDB',
  'AWS Security Hub': 'Security Hub',
  'Amazon Simple Email Service': 'SES',
  'AWS Backup': 'Backup',
  'Amazon Elastic MapReduce': 'EMR',
  'AWS Systems Manager': 'Systems Manager',
  'AWS X-Ray': 'X-Ray',
  Tax: 'Tax',
};

export function shortService(name: string): string {
  if (SERVICE_SHORT[name]) return SERVICE_SHORT[name];
  return name.replace(/^(Amazon|AWS)\s+/, '');
}

interface Rule {
  /** test against service name; omit = any */
  svc?: RegExp;
  re: RegExp;
  label: string | ((m: RegExpMatchArray) => string);
}

const R = (re: RegExp, label: Rule['label'], svc?: RegExp): Rule => ({ re, label, svc });

const CW = /CloudWatch/;
const EC2 = /Elastic Compute Cloud|EC2/;
const RDS = /Relational Database/;
const S3 = /Simple Storage/;

// Order matters: first match wins.
const RULES: Rule[] = [
  // ── CloudWatch ──
  R(/^DataProcessing-Bytes|^DataProcessingIA-Bytes/, 'Log ingestion', CW),
  R(/^VendedLog(IA)?-Bytes/, 'Vended log ingestion (VPC flow, Route 53…)', CW),
  R(/^TimedStorage-ByteHrs/, 'Log storage', CW),
  R(/^DataScanned-Bytes/, 'Logs Insights queries', CW),
  R(/^CW:MetricMonitorUsage/, 'Custom metrics', CW),
  R(/^CW:AlarmMonitorUsage|^CW:HighResAlarm|^CW:CompositeAlarm|^CW:MetricInsightAlarm/, 'Alarms', CW),
  R(/^DashboardsUsageHour/, 'Dashboards', CW),
  R(/^CW:GMD-Metrics|^CW:GMD/, 'GetMetricData API (monitoring tools pulling metrics)', CW),
  R(/^CW:Requests/, 'Metrics API requests', CW),
  R(/^CW:MetricStreamUsage/, 'Metric streams', CW),
  R(/^CW:ContributorInsight/, 'Contributor Insights', CW),
  R(/^CW:Canary|^Canary/, 'Synthetics canaries', CW),
  R(/^S3-Egress|^Logs-.*Delivery/, 'Log delivery', CW),
  R(/Application-Signals|AppSignals/, 'Application Signals', CW),
  R(/ObservabilityAdminTelemetry|^CW:.*Events/, 'Events', CW),

  // ── EC2 compute ──
  R(/^BoxUsage:(.+)$/, (m) => `On-Demand ${m[1]} instances`),
  R(/^BoxUsage$/, 'On-Demand m1.small instances'),
  R(/^SpotUsage:(.+)$/, (m) => `Spot ${m[1]} instances`),
  R(/^HeavyUsage:(.+)$/, (m) => `Reserved ${m[1]} instances`),
  R(/^DedicatedUsage:(.+)$/, (m) => `Dedicated ${m[1]} instances`),
  R(/^UnusedBox:(.+)$/, (m) => `Unused capacity reservation (${m[1]})`),
  R(/^UnusedDed:(.+)$/, (m) => `Unused dedicated reservation (${m[1]})`),
  R(/^CPUCredits:(.+)$/, (m) => `${m[1]} unlimited-mode CPU credits`),
  R(/^EBSOptimized:(.+)$/, (m) => `EBS-optimized surcharge (${m[1]})`),

  // ── EBS ──
  R(/^EBS:VolumeUsage\.(\w+)/, (m) => `EBS ${m[1]} volume storage`),
  R(/^EBS:VolumeUsage$/, 'EBS magnetic volume storage'),
  R(/^EBS:VolumeP-IOPS\.(\w+)/, (m) => `EBS ${m[1]} provisioned IOPS`),
  R(/^EBS:VolumeP-Throughput\.(\w+)/, (m) => `EBS ${m[1]} provisioned throughput`),
  R(/^EBS:SnapshotUsage/, 'EBS snapshots'),
  R(/^EBS:SnapshotArchive/, 'EBS archived snapshots'),
  R(/^EBS:FastSnapshotRestore/, 'EBS fast snapshot restore'),
  R(/^EBS:/, 'EBS (other)'),

  // ── Networking ──
  R(/^NatGateway-Bytes/, 'NAT Gateway data processing'),
  R(/^NatGateway-Hours/, 'NAT Gateway hours'),
  R(/^PublicIPv4:IdleAddress/, 'Idle public IPv4 addresses'),
  R(/^PublicIPv4:InUseAddress/, 'In-use public IPv4 addresses'),
  R(/^ElasticIP:IdleAddress/, 'Idle Elastic IPs'),
  R(/^VpcEndpoint-Hours/, 'VPC interface endpoint hours'),
  R(/^VpcEndpoint-Bytes/, 'VPC endpoint data processing'),
  R(/^TransitGateway-Bytes/, 'Transit Gateway data processing'),
  R(/^TransitGateway-Hours/, 'Transit Gateway attachments'),
  R(/^VPN-Usage-Hours/, 'VPN connection hours'),
  R(/^DataTransfer-Regional-Bytes/, 'Data transfer between Availability Zones'),
  R(/^DataTransfer-Out-Bytes/, 'Data transfer out to the internet'),
  R(/^DataTransfer-In-Bytes/, 'Data transfer in'),
  R(/^DataTransfer-xAZ/, 'Data transfer between Availability Zones'),
  R(/^AWS-Out-Bytes/, 'Data transfer to another AWS region'),
  R(/^AWS-In-Bytes/, 'Data transfer from another AWS region'),
  R(/^CloudFront-Out-Bytes/, 'Data transfer to CloudFront'),
  R(/^LoadBalancerUsage/, 'Load balancer hours'),
  R(/^LCUUsage/, 'Load balancer capacity units (traffic)'),
  R(/^DataProcessing-Bytes/, 'Load balancer data processing', /Load Balancing/),

  // ── RDS ──
  R(/ExtendedSupport/, 'Extended Support surcharge (end-of-life engine version)'),
  R(/^Multi-AZUsage:(.+)$/, (m) => `Multi-AZ ${m[1]} instances`, RDS),
  R(/^Multi-AZClusterUsage:(.+)$/, (m) => `Multi-AZ cluster ${m[1]} instances`, RDS),
  R(/^InstanceUsage(?:IOOptimized)?:(.+)$/, (m) => `${m[1]} instances`, RDS),
  R(/^HeavyUsage:(.+)$/, (m) => `Reserved ${m[1]} instances`, RDS),
  R(/^RDS:(Multi-AZ-)?GP2-Storage/, 'gp2 database storage', RDS),
  R(/^RDS:(Multi-AZ-)?GP3-Storage/, 'gp3 database storage', RDS),
  R(/^RDS:(Multi-AZ-)?PIOPS/, 'Provisioned IOPS', RDS),
  R(/^RDS:(Multi-AZ-)?StorageUsage/, 'Database storage', RDS),
  R(/^Aurora:StorageUsage/, 'Aurora storage', RDS),
  R(/^Aurora:StorageIOUsage/, 'Aurora I/O requests', RDS),
  R(/^Aurora:BackupUsage|^RDS:ChargedBackupUsage/, 'Database backup storage', RDS),
  R(/^Aurora:ServerlessV2Usage|ServerlessUsage/, 'Aurora Serverless capacity', RDS),
  R(/^RDS:.*Proxy/, 'RDS Proxy', RDS),
  R(/^PI_API|PerformanceInsights/, 'Performance Insights', RDS),

  // ── S3 ──
  R(/^TimedStorage-ByteHrs/, 'S3 Standard storage', S3),
  R(/^TimedStorage-SIA-ByteHrs/, 'S3 Standard-IA storage', S3),
  R(/^TimedStorage-ZIA-ByteHrs/, 'S3 One Zone-IA storage', S3),
  R(/^TimedStorage-INT-(FA|IA|AIA|AA|DAA)-ByteHrs/, (m) => `S3 Intelligent-Tiering storage (${m[1]})`, S3),
  R(/^TimedStorage-GlacierByteHrs|^TimedStorage-GIR|^TimedStorage-GDA/, 'S3 Glacier storage', S3),
  R(/^TimedStorage-RRS/, 'S3 Reduced Redundancy storage', S3),
  R(/^Requests-Tier1/, 'S3 write/list requests (PUT, LIST)', S3),
  R(/^Requests-Tier2/, 'S3 read requests (GET)', S3),
  R(/^Requests-/, 'S3 requests', S3),
  R(/^Monitoring-Automation-INT/, 'Intelligent-Tiering monitoring fee', S3),
  R(/^StorageAnalytics|^Inventory|^StorageLens/, 'S3 analytics & inventory', S3),
  R(/^EarlyDelete/, 'Early deletion fees', S3),
  R(/^Retrieval/, 'Retrieval fees', S3),
  R(/^Select-/, 'S3 Select', S3),

  // ── Lambda / containers ──
  R(/^Lambda-GB-Second-ARM/, 'Lambda compute (Arm)'),
  R(/^Lambda-GB-Second/, 'Lambda compute (x86)'),
  R(/^Lambda-Provisioned/, 'Lambda provisioned concurrency'),
  R(/^Request-ARM|^Request$/, 'Lambda requests', /Lambda/),
  R(/^Fargate-vCPU-Hours/, 'Fargate vCPU'),
  R(/^Fargate-ARM-vCPU-Hours/, 'Fargate vCPU (Arm)'),
  R(/^Fargate-(ARM-)?GB-Hours/, 'Fargate memory'),
  R(/^SpotUsage-Fargate|Fargate.*Spot/, 'Fargate Spot'),
  R(/^AmazonEKS-Hours:perCluster/, 'EKS cluster hours'),
  R(/^AmazonEKS-Hours:extendedSupport/, 'EKS Extended Support surcharge (old Kubernetes version)'),

  // ── Databases / caches / search ──
  R(/^NodeUsage:(.+)$/, (m) => `${m[1]} nodes`),
  R(/^ESInstance:(.+)$/, (m) => `${m[1]} search nodes`),
  R(/^ES:(.+)-Storage/, (m) => `OpenSearch ${m[1]} storage`),
  R(/^ReadCapacityUnit-Hrs/, 'DynamoDB provisioned read capacity'),
  R(/^WriteCapacityUnit-Hrs/, 'DynamoDB provisioned write capacity'),
  R(/^ReadRequestUnits/, 'DynamoDB on-demand reads'),
  R(/^WriteRequestUnits/, 'DynamoDB on-demand writes'),
  R(/^TimedStorage-ByteHrs/, 'DynamoDB table storage', /DynamoDB/),
  R(/^TimedBackupStorage|^TimedPITRStorage/, 'DynamoDB backups', /DynamoDB/),
  R(/^Node:(.+)$/, (m) => `Redshift ${m[1]} nodes`),

  // ── Governance / security ──
  R(/PaidEventsRecorded/, 'Extra copies of management events (duplicate trails)', /CloudTrail/),
  R(/DataEventsRecorded/, 'Data events', /CloudTrail/),
  R(/InsightsEvents/, 'CloudTrail Insights', /CloudTrail/),
  R(/ConfigurationItemRecorded/, 'Configuration items recorded', /Config/),
  R(/ConfigRuleEvaluations|ConformancePack/, 'Config rule evaluations', /Config/),
  R(/KMS-Keys/, 'KMS keys'),
  R(/KMS-Requests/, 'KMS API requests'),
  R(/^AWSSecretsManager-Secrets|Secrets$/, 'Secrets stored'),
  R(/^AWSSecretsManagerAPIRequest/, 'Secrets Manager API requests'),

  // ── CloudFront / Route53 ──
  R(/DataTransfer-Out-Bytes|Out-Bytes/, 'CloudFront data transfer out', /CloudFront/),
  R(/Requests-(HTTPS?|Tier)/, 'CloudFront requests', /CloudFront/),
  R(/^HostedZone/, 'Hosted zones'),
  R(/^DNS-Queries/, 'DNS queries'),

  // ── AI ──
  R(/InputTokenCount|input-tokens/i, 'Model input tokens'),
  R(/OutputTokenCount|output-tokens/i, 'Model output tokens'),
  R(/ProvisionedThroughput/, 'Provisioned throughput'),

  // generic fallbacks
  R(/DataTransfer|Bytes$/, 'Data transfer'),
];

/** Human label for a usage type. Falls back to the (region-stripped) raw usage type. */
export function describeUsage(service: string, usageType: string): string {
  const u = stripRegion(usageType);
  for (const r of RULES) {
    if (r.svc && !r.svc.test(service)) continue;
    const m = u.match(r.re);
    if (m) return typeof r.label === 'function' ? r.label(m) : r.label;
  }
  return u;
}

// ── Instance family knowledge ──

/** Previous-generation families and their modern replacement */
export const OLD_GEN: Record<string, string> = {
  t1: 't3',
  t2: 't3',
  m1: 'm7i',
  m2: 'r7i',
  m3: 'm7i',
  m4: 'm7i',
  c1: 'c7i',
  c3: 'c7i',
  c4: 'c7i',
  r3: 'r7i',
  r4: 'r7i',
  i2: 'i4i',
  i3: 'i4i',
  d2: 'd3',
  x1: 'x2i',
  g3: 'g5',
  p2: 'p3',
};

/** x86 families with a drop-in Graviton equivalent (managed services only make this a one-click change) */
export const GRAVITON_EQUIV: Record<string, string> = {
  t3: 't4g',
  m5: 'm7g',
  m6i: 'm7g',
  r5: 'r7g',
  r6i: 'r7g',
  c5: 'c7g',
  c6i: 'c7g',
};

/** "db.r5.2xlarge" | "cache.m5.large" | "m5.xlarge" | "r5.large.search" -> "r5" */
export function instanceFamily(instanceType: string): string | null {
  const m = instanceType.replace(/^(db|cache)\./, '').match(/^([a-z]+\d+[a-z-]*)\./);
  return m ? m[1] : null;
}

/** Extract the instance type from a usage type like "USW2-BoxUsage:m5.large" */
export function usageInstanceType(usageType: string): string | null {
  const m = stripRegion(usageType).match(/^(?:BoxUsage|InstanceUsage|InstanceUsageIOOptimized|Multi-AZUsage|NodeUsage|ESInstance|HeavyUsage|SpotUsage|DedicatedUsage):(.+)$/);
  return m ? m[1] : null;
}

export const REGION_NAMES: Record<string, string> = {
  'us-east-1': 'N. Virginia',
  'us-east-2': 'Ohio',
  'us-west-1': 'N. California',
  'us-west-2': 'Oregon',
  'eu-west-1': 'Ireland',
  'eu-west-2': 'London',
  'eu-west-3': 'Paris',
  'eu-central-1': 'Frankfurt',
  'eu-north-1': 'Stockholm',
  'ap-southeast-1': 'Singapore',
  'ap-southeast-2': 'Sydney',
  'ap-northeast-1': 'Tokyo',
  'ap-northeast-2': 'Seoul',
  'ap-south-1': 'Mumbai',
  'sa-east-1': 'São Paulo',
  'ca-central-1': 'Canada',
  global: 'Global',
};

export const DIM_LABEL: Record<string, string> = {
  SERVICE: 'Service',
  USAGE_TYPE: 'Usage type',
  REGION: 'Region',
  LINKED_ACCOUNT: 'Account',
  OPERATION: 'API operation',
  PURCHASE_TYPE: 'Purchase option',
  INSTANCE_TYPE: 'Instance type',
  RECORD_TYPE: 'Charge type',
};

export function dimLabel(dim: string): string {
  if (dim.startsWith('TAG:')) return `Tag: ${dim.slice(4)}`;
  return DIM_LABEL[dim] ?? dim;
}

export const BASIS_LABEL: Record<string, string> = {
  UnblendedCost: 'unblended',
  NetUnblendedCost: 'net unblended',
  AmortizedCost: 'amortized',
  NetAmortizedCost: 'net amortized',
};
