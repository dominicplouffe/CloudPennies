// The read-only IAM permissions CloudPennies uses. Keep in sync with docs/IAM_POLICY.json
// (tests/collector.test.ts checks that they match).

/** Required: billing, Cost Explorer, budgets and Cost Optimization Hub (read-only). */
export const IAM_POLICY_BILLING: string[] = [
  'ce:GetCostAndUsage',
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

export function iamPolicyJson(includeScan: boolean): string {
  const statements = [{ Sid: 'CloudPenniesBilling', Effect: 'Allow', Action: IAM_POLICY_BILLING, Resource: '*' }];
  if (includeScan) statements.push({ Sid: 'CloudPenniesResourceScan', Effect: 'Allow', Action: IAM_POLICY_SCAN, Resource: '*' });
  return JSON.stringify({ Version: '2012-10-17', Statement: statements }, null, 2);
}
