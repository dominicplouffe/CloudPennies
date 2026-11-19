// Pure: translate a CUR product code / usage type into the SERVICE name Cost Explorer uses, so that
// resource-level rows line up with everything else in the app.
import type { CostRow } from '../../../src/core/types';

/** usage type -> Cost Explorer service names seen with it */
export type KnownServices = Map<string, Set<string>>;

export const EC2_COMPUTE = 'Amazon Elastic Compute Cloud - Compute';
export const EC2_OTHER = 'EC2 - Other';

/**
 * CUR product code -> Cost Explorer SERVICE name(s). Only used to choose between several candidates,
 * or when the scan has never seen the usage type. Names are Cost Explorer's own spelling.
 */
export const PRODUCT_SERVICES: Record<string, string[]> = {
  AmazonEC2: [EC2_COMPUTE, EC2_OTHER],
  AmazonS3: ['Amazon Simple Storage Service'],
  AmazonCloudWatch: ['AmazonCloudWatch'],
  AmazonRDS: ['Amazon Relational Database Service'],
  AmazonDynamoDB: ['Amazon DynamoDB'],
  AWSLambda: ['AWS Lambda'],
  AmazonVPC: ['Amazon Virtual Private Cloud'],
  AmazonECS: ['Amazon Elastic Container Service'],
  AmazonEKS: ['Amazon Elastic Container Service for Kubernetes'],
  AmazonECR: ['Amazon EC2 Container Registry (ECR)'],
  AmazonElastiCache: ['Amazon ElastiCache'],
  AmazonES: ['Amazon OpenSearch Service'],
  AWSELB: ['Amazon Elastic Load Balancing'],
  AWSCloudTrail: ['AWS CloudTrail'],
  AWSConfig: ['AWS Config'],
  awskms: ['AWS Key Management Service'],
  AmazonRoute53: ['Amazon Route 53'],
  AmazonCloudFront: ['Amazon CloudFront'],
  AmazonBedrock: ['Amazon Bedrock'],
  AmazonRedshift: ['Amazon Redshift'],
  AmazonMemoryDB: ['Amazon MemoryDB'],
  AmazonEFS: ['Amazon Elastic File System'],
  AmazonSNS: ['Amazon Simple Notification Service'],
  AWSQueueService: ['Amazon Simple Queue Service'],
  AWSSecretsManager: ['AWS Secrets Manager'],
  AmazonSageMaker: ['Amazon SageMaker'],
  AmazonApiGateway: ['Amazon API Gateway'],
  AWSGlue: ['AWS Glue'],
  AmazonAthena: ['Amazon Athena'],
  AmazonKinesis: ['Amazon Kinesis'],
  AmazonGuardDuty: ['Amazon GuardDuty'],
  AWSDataTransfer: ['AWS Data Transfer'],
};

const lowerCodes = new Map(Object.entries(PRODUCT_SERVICES).map(([k, v]) => [k.toLowerCase(), v]));

/** Instance-hour usage types: everything else billed under AmazonEC2 (EBS, NAT, data transfer, IPs) is "EC2 - Other". */
const EC2_COMPUTE_USAGE = /(^|[-:])(BoxUsage|SpotUsage|HeavyUsage|DedicatedUsage|HostBoxUsage|HostUsage|UnusedBox|UnusedDed|ReservedHostUsage|SchedUsage)(:|$)/i;

export const isEc2ComputeUsage = (usageType: string): boolean => EC2_COMPUTE_USAGE.test(usageType);

/** Build the usage type -> services map from the scan's own Cost Explorer rows (keys [SERVICE, USAGE_TYPE]). */
export function buildKnownServices(rows: readonly CostRow[]): KnownServices {
  const known: KnownServices = new Map();
  for (const r of rows) {
    const service = r.keys[0];
    const usageType = r.keys[1];
    if (!service || usageType === undefined) continue;
    let set = known.get(usageType);
    if (!set) known.set(usageType, (set = new Set()));
    set.add(service);
  }
  return known;
}

export function mergeKnownServices(into: KnownServices, from: KnownServices): KnownServices {
  for (const [usageType, services] of from) {
    let set = into.get(usageType);
    if (!set) into.set(usageType, (set = new Set()));
    for (const s of services) set.add(s);
  }
  return into;
}

export const knownServicesToJson = (known: KnownServices): Record<string, string[]> =>
  Object.fromEntries([...known].map(([k, v]) => [k, [...v].sort()]));

export function knownServicesFromJson(json: unknown): KnownServices {
  const known: KnownServices = new Map();
  if (!json || typeof json !== 'object') return known;
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (Array.isArray(v)) known.set(k, new Set(v.filter((x): x is string => typeof x === 'string')));
  }
  return known;
}

function fromTable(productCode: string, usageType: string, allowed?: Set<string>): string | undefined {
  const names = lowerCodes.get(productCode.toLowerCase());
  if (!names) return undefined;
  const ok = allowed ? names.filter((n) => allowed.has(n)) : names;
  if (!ok.length) return undefined;
  if (ok.length === 1) return ok[0];
  // only AmazonEC2 maps to two services
  const wanted = isEc2ComputeUsage(usageType) ? EC2_COMPUTE : EC2_OTHER;
  return ok.includes(wanted) ? wanted : ok[0];
}

/**
 * The Cost Explorer SERVICE name for a CUR line.
 *  1. Cost Explorer reported exactly one service for this usage type -> that one (unless the product
 *     code is a well-known one that belongs to a different service).
 *  2. Several -> the one that belongs to the product code (table + the EC2 compute/other split),
 *     else the one equal to the product name, else the first alphabetically (stable).
 *  3. Never seen -> the table's name for the product code when there is one (so that e.g. AmazonEC2
 *     does not turn into a third spelling), else the product name, else the product code.
 */
export function resolveService(productCode: string, productName: string, usageType: string, known: KnownServices): string {
  if (productCode === 'Tax') return 'Tax';
  const candidates = known.get(usageType);
  if (candidates && candidates.size === 1) {
    const only = candidates.values().next().value as string;
    // A usage type such as data transfer is shared by several products; when the table knows this product
    // under a different service than the single one Cost Explorer happened to report, trust the table.
    const names = lowerCodes.get(productCode.toLowerCase());
    return names && !names.includes(only) ? (fromTable(productCode, usageType) ?? only) : only;
  }
  if (candidates && candidates.size > 1) {
    const viaTable = fromTable(productCode, usageType, candidates);
    if (viaTable) return viaTable;
    if (productName && candidates.has(productName)) return productName;
    if (candidates.has(productCode)) return productCode;
    return [...candidates].sort()[0];
  }
  return fromTable(productCode, usageType) ?? (productName || productCode || 'Unknown');
}
