# Scanning member accounts

In an AWS Organization, CloudPennies is connected with a key from the **management (payer) account**. That is
enough for all cost data, but the resource scan (unattached volumes, idle load balancers, log groups that never
expire, ...) can only see resources in the account it is signed in to, and most resources live in member accounts.

To include them, create one small **read-only role with the same name in every member account**. During a scan
CloudPennies assumes `arn:aws:iam::<member-account>:role/<RoleName>` with STS, for one hour, and runs the same
read-only describe calls there. Nothing is installed and nothing can be changed through the role.

What the role contains ([`member-role.yaml`](member-role.yaml)):

- **Trust policy:** only your management account may assume it.
- **Permissions:** exactly the `CloudPenniesResourceScan` actions from [`IAM_POLICY.json`](IAM_POLICY.json)
  (11 `Describe*` / `List*` / `Lookup*` actions). No data access, no write access.

## 1. Deploy the role to every member account (once)

Run from the management account (or a delegated StackSets administrator). Replace `111111111111` with the
management account id and `r-xxxx` with your organization root id
(`aws organizations list-roots --query 'Roots[0].Id' --output text`).

```sh
aws cloudformation create-stack-set \
  --stack-set-name CloudPenniesReadOnly \
  --template-body file://docs/member-role.yaml \
  --parameters ParameterKey=ManagementAccountId,ParameterValue=111111111111 \
               ParameterKey=RoleName,ParameterValue=CloudPenniesReadOnly \
  --capabilities CAPABILITY_NAMED_IAM \
  --permission-model SERVICE_MANAGED \
  --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false

aws cloudformation create-stack-instances \
  --stack-set-name CloudPenniesReadOnly \
  --deployment-targets OrganizationalUnitIds=r-xxxx \
  --regions us-east-1
```

Notes:

- IAM is global, so one region is enough. Accounts that join the organization later get the role automatically.
- Service-managed StackSets need trusted access between CloudFormation and Organizations
  (CloudFormation console → StackSets → *Enable trusted access*, once).
- To cover only some accounts, pass an OU id (`ou-xxxx-xxxxxxxx`) instead of the root id.
- The management account itself is not a StackSet target and does not need the role: it is scanned with the
  connected credentials.

## 2. Let the CloudPennies user assume it

Add this statement to the policy of the IAM user or role CloudPennies is connected with (it is the third,
optional statement in [`IAM_POLICY.json`](IAM_POLICY.json)):

```json
{
  "Sid": "CloudPenniesAssumeMemberRole",
  "Effect": "Allow",
  "Action": ["sts:AssumeRole"],
  "Resource": "arn:aws:iam::*:role/CloudPenniesReadOnly"
}
```

## 3. Tell CloudPennies the role name

Settings → **Member role name** → `CloudPenniesReadOnly`, then run a scan.

## What gets scanned

- The connected account, always.
- Member accounts with at least $1 of spend in the last 30 days, highest spend first, at most 40 per scan.
- The same regions as before (those with spend).

An account that cannot be entered never fails the scan: it is skipped, and the scan reports once how many
accounts were skipped and which. The usual causes are a missing role in that account (stack instance failed or
the account is outside the targeted OU), a different role name, a missing `sts:AssumeRole` statement (step 2),
or a service control policy that denies `sts:AssumeRole`.

## Removing it

```sh
aws cloudformation delete-stack-instances --stack-set-name CloudPenniesReadOnly \
  --deployment-targets OrganizationalUnitIds=r-xxxx --regions us-east-1 --no-retain-stacks
aws cloudformation delete-stack-set --stack-set-name CloudPenniesReadOnly
```
