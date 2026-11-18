// The read-only IAM permissions CloudPennies uses. Keep in sync with docs/IAM_POLICY.json and
// docs/member-role.yaml (tests/collector.test.ts checks that they match).

/** Required: billing, Cost Explorer, budgets and Cost Optimization Hub (read-only). */
export const IAM_POLICY_BILLING: string[] = [
  'ce:GetCostAndUsage',
  'ce:GetCostAndUsageWithResources',
  'ce:GetDimensionValues',
  'ce:GetTags',
  'ce:GetCostForecast',
  'ce:GetAnomalies',
  'ce:GetSavingsPlansUtilizationDetails',
  'ce:GetSavingsPlansCoverage',
  'ce:GetSavingsPlansPurchaseRecommendation',
  'ce:GetReservationUtilization',
  'ce:GetReservationCoverage',
  'ce:GetReservationPurchaseRecommendation',
  'ce:GetRightsizingRecommendation',
  'budgets:ViewBudget',
  'cost-optimization-hub:ListRecommendations',
  'sts:GetCallerIdentity',
];

/** Optional: resource-level scan for idle and forgotten resources (read-only describe calls). */
export const IAM_POLICY_SCAN: string[] = [
  'logs:DescribeLogGroups',
  'cloudwatch:ListDashboards',
  'cloudwatch:DescribeAlarms',
  'cloudtrail:LookupEvents',
  'ec2:DescribeVolumes',
  'ec2:DescribeAddresses',
  'ec2:DescribeSnapshots',
  'ec2:DescribeInstances',
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeTargetGroups',
  'elasticloadbalancing:DescribeTargetHealth',
];

/**
 * Optional: enter member accounts of an AWS Organization to run the resource scan there
 * (see docs/MEMBER_ROLE.md). Scoped to the one read-only role, never `*`.
 */
export const IAM_POLICY_ASSUME: string[] = ['sts:AssumeRole'];

/**
 * Optional: read the Cost and Usage Report for resource-level cost history (see docs/CUR.md).
 * The first two are scoped to the report bucket; the listing actions do not support resource scoping.
 */
export const IAM_POLICY_CUR: string[] = [
  's3:GetObject',
  's3:ListBucket',
  'bcm-data-exports:ListExports',
  'bcm-data-exports:GetExport',
  'cur:DescribeReportDefinitions',
];

const CUR_S3_ACTIONS = ['s3:GetObject', 's3:ListBucket'];

/** Role name used in the docs and the CloudFormation template (docs/member-role.yaml). */
export const DEFAULT_MEMBER_ROLE_NAME = 'CloudPenniesReadOnly';

/**
 * The policy to attach to the CloudPennies user/role.
 * The AssumeRole statement is only included when `memberRoleName` is a non-empty string.
 * The Cost and Usage Report statements are only included when `curBucket` (the bucket the export
 * delivers to) is given: S3 read access to that bucket and its objects, and the export listing actions.
 */
export function iamPolicyJson(includeScan: boolean, memberRoleName?: string, curBucket?: string): string {
  const statements: { Sid: string; Effect: 'Allow'; Action: string[]; Resource: string | string[] }[] = [
    { Sid: 'CloudPenniesBilling', Effect: 'Allow', Action: IAM_POLICY_BILLING, Resource: '*' },
  ];
  if (includeScan) statements.push({ Sid: 'CloudPenniesResourceScan', Effect: 'Allow', Action: IAM_POLICY_SCAN, Resource: '*' });
  const role = typeof memberRoleName === 'string' ? memberRoleName.trim().replace(/^\/+/, '') : '';
  if (role) {
    statements.push({ Sid: 'CloudPenniesAssumeMemberRole', Effect: 'Allow', Action: IAM_POLICY_ASSUME, Resource: `arn:aws:iam::*:role/${role}` });
  }
  const bucket = typeof curBucket === 'string' ? curBucket.trim().replace(/^s3:\/\//i, '').replace(/\/.*$/, '') : '';
  if (bucket) {
    statements.push({
      Sid: 'CloudPenniesCostAndUsageReport',
      Effect: 'Allow',
      Action: IAM_POLICY_CUR.filter((a) => CUR_S3_ACTIONS.includes(a)),
      Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
    });
    statements.push({
      Sid: 'CloudPenniesCostAndUsageReportList',
      Effect: 'Allow',
      Action: IAM_POLICY_CUR.filter((a) => !CUR_S3_ACTIONS.includes(a)),
      Resource: '*',
    });
  }
  return JSON.stringify({ Version: '2012-10-17', Statement: statements }, null, 2);
}
