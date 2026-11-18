# CloudPennies — Competitive & Practice Research

_AWS cost analysis / optimization tool survey. Compiled 2026-11-18._

## How to read this document

Confidence markers used throughout:

- **[S]** — found in a source during this research pass (see Sources).
- **[K]** — stated from prior knowledge of the product/docs; **not re-verified in this pass**. Treat as "probably right, check before shipping copy or logic that depends on it".
- **[?]** — uncertain, conflicting sources, or inferred.

**Research limitations (important).** The research sandbox could not open most primary sites directly (`docs.aws.amazon.com`, `aws.amazon.com`, `hub.powerpipe.io`, `finops.org`, `docs.vantage.sh`, `dev.to`, `hn.algolia.com` all failed DNS resolution). Consequences:

- The **AWS Thrifty control list is exact** — pulled directly from the mod's source files on GitHub.
- The **Trusted Advisor check list and Cost Optimization Hub resource-type list are from memory [K]**, cross-checked only against search snippets. Verify against the AWS docs (URLs in Sources) or by calling `support:DescribeTrustedAdvisorChecks` / reading the `cost-optimization-hub` API enum.
- **Practitioner complaints**: no primary Reddit/HN threads could be opened. What is here is from review aggregators, vendor blogs quoting practitioners, and search snippets. Much of the "X is weak at Y" material online is written by X's competitors; it is flagged where that applies.
- Third-party vendor feature descriptions are mostly from search-result summaries of vendor pages, not hands-on use.

---

## 1. Tool survey

### 1a. AWS native

| Tool | What it's best at | Signature UX idea worth borrowing | Weakness / complaint |
|---|---|---|---|
| **Cost Explorer** | Free, authoritative spend slicing by service / account / usage type / tag; forecasts; RI & SP coverage/utilization reports; API for everything. Forecast horizon extended to 18 months and "explainable AI insights" added at re:Invent 2025 [S, secondary recap]. | Group-by + filter pivot with a single bar chart; saved reports. The `UsageType` dimension is the richest free signal available. | "EC2-Other" is a confusing catch-all; blended vs unblended vs amortized cost confuses people [S: Vantage blog]. Shows where savings could exist but does not explain or act [S]. Coarse access control [S: Holori, vendor]. API is billed per request [K: $0.01/request]. |
| **Cost Comparison (Cost Explorer, May 2025)** | Automatic month-vs-month "what changed and why": detects significant changes between any two months in the last 13, and breaks drivers into usage change, discount change, credits, refunds, fees, commitment-based savings [S]. | **Top 3 drivers auto-highlighted, "View all" for the rest**; Billing home "Top Trends" widget shows top 10 variations sorted by absolute $ with both % and $ shown [S]. APIs: `GetCostAndUsageComparisons`, `GetCostComparisonDrivers` [S]. | Month granularity only; two-period comparison only; no narrative, no owner attribution. |
| **Cost Anomaly Detection** | Free ML anomaly detection with root-cause ranking: ranks combinations of service, account, region, usage type by impact, **up to top 10 root causes** with $ contribution (Nov 2024) [S]. Managed monitors extended to linked accounts, cost-allocation tags and cost categories (Nov 2025) [S]. | Anomaly = (expected vs actual, total impact, ranked root causes). `ce:GetAnomalies` exposes this to us for free. | Root causes do not sum to the anomaly — impact is net, root causes show only increases [S: AWS FAQ]. Managed-monitor subscriptions use one threshold across all tracked values [S, third-party]. Root causes stop at service/account/region/usage type — no team/owner unless tag monitors exist [S, third-party]. Daily, delayed data [K]. |
| **Cost Optimization Hub** | One consolidated, **de-duplicated** list of savings actions across accounts/regions, with estimated savings that account for existing discounts [K]. FAQ says 18 recommendation types [S]. Action types (API enum): `Rightsize, Stop, Upgrade, PurchaseSavingsPlans, PurchaseReservedInstances, MigrateToGraviton, Delete, ScaleIn` [S]. Now exportable via Data Exports [S]. | **Group by action type, sorted by savings, with implementation effort and "restart needed / rollback possible" flags** [K]. This is the best ready-made "what do I do" feed. | Opt-in; needs Compute Optimizer enabled for rightsizing/idle [S]. Just a list — nothing explains or prioritizes for a non-expert. |
| **Compute Optimizer** | Metric-based rightsizing (EC2, ASG, EBS, Lambda, ECS on Fargate, RDS/Aurora [S/K]) and idle detection. **June 2026: idle recommendations added for DynamoDB provisioned tables, ElastiCache (Redis/Valkey), MemoryDB, DocumentDB, WorkSpaces, SageMaker endpoints** [S]. 32-day lookback for EBS/ECS (June 2026) [S]. | Finding classes: *Under-provisioned / Over-provisioned / Optimized / Idle*, plus a performance-risk rating on each option [K]. | No recommendations for Spot instances; ASGs with unsupported types excluded [S]. Memory metrics need CloudWatch agent [K]. Engineers distrust CPU-only rightsizing [K]. |
| **Trusted Advisor (cost checks)** | Simple red/yellow/green checklist of classic waste (idle LBs, unassociated EIPs, low-utilization EC2, idle RDS, underutilized EBS, RI/SP optimization, RI lease expiration) [S]. Newer checks are sourced from Cost Optimization Hub [S]. | **Traffic-light checklist with estimated monthly savings per check** — the most understandable format AWS ships. | Full check set requires a paid support plan (Business/Enterprise) [S]. Thresholds are blunt (e.g. CPU <10% for 14 days) [S, third-party]. Support API only in us-east-1 [S, third-party]. |
| **CUDOS / Cloud Intelligence Dashboards** | Deep, free (QuickSight + CUR) dashboards. CUDOS tabs: Executive (incl. MoM Trends), Compute, Databases, Storage, AI/ML, Analytics, Security, Data Transfer [S]. Sibling dashboards: KPI, Trends, Data Transfer, Trusted Advisor Organizational (TAO), Compute Optimizer [S]. | **Executive tab → drill-down tabs per domain; "cost per unit of usage" visuals (e.g. $/GB, $/vCPU-hour) that separate rate changes from usage changes** [K]. KPI dashboard tracks modernization goals (gp3 adoption, Graviton %, etc.) against targets [K]. | Heavy setup (CUR, Athena, QuickSight, CloudFormation); dense — built for FinOps analysts, the opposite of "time-poor owner". |
| **Billing & Cost Management home / dashboards (2025–2026)** | Custom dashboards with widgets: Budgets widget (May 2026) [S], **Cost Efficiency widget (July 2026)** [S, title only — definition not verified; believed to be a score relating potential savings to optimizable spend [?]]. Historical retention for billing-group accounts (June 2026) [S]. Account-level tags usable in CE/CUR/Budgets [S, secondary]. Database Savings Plans (re:Invent 2025) [S, secondary]. | A single "efficiency" number on the home page. | Still a toolbox, not an opinion. |
| **Amazon Q / Billing & Cost Management MCP server** | Natural-language cost Q&A; "Analyze with Amazon Q" in Cost Explorer [S, third-party]; MCP server for cost analysis in dev tools (re:Invent 2025) [S, secondary]. | Ask a question, get a narrated answer with the query behind it. | Accuracy/trust; requires knowing what to ask. |

### 1b. Commercial platforms

| Tool | What it's best at | Signature UX idea worth borrowing | Weakness / complaint |
|---|---|---|---|
| **Vantage** | Fast setup, clean Cost Reports across many providers; virtual tags; unit costs; network flow reports; Autopilot (automated SP purchasing); K8s rightsizing; anomaly + budget alerts [S]. "Working dashboard in an afternoon" with a real free tier [S: Amnic, vendor]. | **Cost Report = saved filter set + one chart + one table with previous-period delta column and per-row sparkline** [K]; folders of reports; issues/annotations on a report [K]; active-resources inventory with per-resource cost [K]. | Network Flow reports hard to set up; some UI criticism; Autopilot AWS-only [S: G2/Gartner summaries]. |
| **CloudZero** | Unit economics (cost per customer/feature/product) and engineering-facing anomaly alerts. Hourly anomaly detection, baselined on 12 months of history, **zero configuration** [S]. | **Anomaly alert routed to the owning team's Slack channel with a "Review Anomaly" deep link; spikes overlaid with deployments** [S]. Alerts capped at 3/day [S]. "Cost per X" as the headline metric rather than total spend. | Unit-cost setup takes real modelling work; enterprise pricing; onboarding time [S: competitor pages — treat as marketing]. |
| **CloudHealth (Broadcom/VMware Tanzu)** | Enterprise governance, policies, perspectives (custom groupings), MSP/reseller billing. Incumbent [S]. | **Perspectives**: user-defined groupings applied retroactively to all reports [K]. Policy → action rules. | Opaque pricing tied to spend tiers; significant renewal increases post-Broadcom [S: multiple vendor sources + Amnic]. Widely described as dated/complex [K, not confirmed this pass]. |
| **Datadog Cloud Cost Management** | Cost next to observability metrics; cost monitors of types **Cost Changes, Cost Anomalies, Cost Threshold, Cost Forecast, Budget** [S]; Tag Pipelines to fix/alias tags retroactively (last 3 months, ≤100 ordered rules) [S]; container cost allocation split into **workload usage / workload idle / cluster idle** [S]. | Fix tagging in the tool, not in the infrastructure. Splitting idle cost explicitly from used cost. Cost correlated with usage metrics on the same graph. | Only worth it if already a Datadog shop; Datadog's own bill is a frequent complaint [K]. |
| **nOps** | AWS-only commitment automation + spot orchestration (Compute Copilot); priced ~20% of savings [S: Spendark, third-party]. | Savings-share framing: "pay only from savings". | % of savings pricing draws skepticism — fee outlives the easy wins [S: CloudZero citing Reddit]. Limited K8s depth [S]. Prolific competitor-comparison content (source bias). |
| **ProsperOps (acquired by Flexera, Jan 2026 [S])** | Autonomous commitment management; invented/popularized **Effective Savings Rate (ESR)** and **Commitment Lock-In Risk (CLR)**; publishes ESR benchmarks [S]. | **Savings dashboard led by ONE outcome metric (ESR) with your percentile vs peers**, paired with a risk metric (CLR in months) [S]. Before/after framing. | Commitment-only (no waste/usage optimization); savings-share pricing [K]. |
| **Finout** | "MegaBill" — one normalized bill across cloud + SaaS + K8s + AI; virtual tags for 100% allocation without touching infra; shared-cost reallocation; commitment burndown tracking [S]. Fixed pricing, no savings fee [S: vendor]. | Virtual tag built in seconds for untagged legacy resources [S: PeerSpot user]. Commitment burndown chart. | Quote-only pricing, K8s add-on, steep onboarding, limited automation [S: Spendark, Gartner reviewer]. |
| **Ternary** | FOCUS-compliant data, finance-system integrations; historically GCP-strong [S: Finout comparison; K]. | Finance-first reporting (budgets/forecast vs actual by cost centre) [K]. | Little independent review data found [S]. |
| **Kubecost (IBM) / OpenCost** | K8s cost allocation by namespace/workload/label; idle cost; OpenCost is the free CNCF allocation engine, Kubecost adds savings insights, request rightsizing, turndown actions [S]. | **"Cluster efficiency" = used ÷ requested ÷ paid-for; idle cost shown as its own line** [K/S]. Savings page listing each insight with monthly $ [K]. | OpenCost has no recommendations [S]. Kubecost free tier: single cluster, 15-day retention [S]. Network cost attribution weak; accuracy gaps with spot/RIs; UI learning curve [S]. |
| **Cast AI** | Automated K8s optimization: replaces Cluster Autoscaler, bin-packing, spot management, workload rightsizing [S]. | Free read-only "savings report": **current cluster cost vs optimized cost side by side** before you enable automation [K]. | Requires deep cluster access; K8s only; ~15% of optimized spend [S: Spendark]. |
| **Spot by Flexera (Ocean, Elastigroup, Eco)** | Spot instance orchestration for stateless workloads; Eco for commitments [S/K]. | Savings-vs-on-demand counter [K]. | 12–36 month contracts [S: nOps, competitor]; ownership churn NetApp → Flexera [K]. |
| **Zesty** | Commitment management (short-term RI trading) and EBS/K8s storage autoscaling; AWS-only [S]. | Refund of part of fee for unused commitments [S: nOps, competitor]. | Narrow scope; AWS only [S]. |
| **Duckbill (Skyway)** | Consulting firm turned software (raised $7.75M, Feb 2026). Skyway: cloud cost **forecasting / financial planning and contract (EDP/PPA) management for large enterprises** — "replaces spreadsheets" [S]. Explicitly not AI-led at launch [S]. | **Contract-aware view**: commitments, EDP burn-down, renewal dates in one place. Duckbill's house style: plain-English, opinionated, narrative findings [K]. | Enterprise-only focus; product details thin publicly [S]. |

### 1c. Open source / CLI

| Tool | What it's best at | Signature UX idea worth borrowing | Weakness / complaint |
|---|---|---|---|
| **Steampipe / Powerpipe "AWS Thrifty" mod** | ~55 SQL-defined waste controls across 20 services, read-only, runs locally [S: source]. Full list in §3. | **Controls phrased as plain questions** ("Still using gp2 EBS volumes? Should use gp3 instead.", "Are there any unattached EBS volumes?") with ok/alarm/info status; thresholds are user variables [S]. | No dollar value on findings; needs resource read access in every region; no prioritization. |
| **Komiser** | Multi-cloud resource inventory with cost, tag-based views; Go, MIT [S]. | Inventory-first: every resource with its cost and tags, filter to "untagged" [K]. | Inventory rather than waste checks [S: third-party comparison]; project momentum uncertain [?]. |
| **Infracost** | Cost of infrastructure changes **before** they ship: PR comment with cost diff; policies (Rego/OPA), guardrails (e.g. alert if PR raises prod cost >10%), tagging policies; can block PRs [S]. | **Diff framing: "+$412/mo (+18%)" at the moment of decision.** | Terraform/IaC only; usage-based costs need assumptions [K]. |
| **Cloud Custodian** | YAML policy engine: find + act (off-hours stop/start, garbage-collect unused resources, tag enforcement, mark-for-op with grace period) [K]. | **"Mark for deletion in N days, notify owner, then act"** workflow [K]. | Policy authoring burden; no UI; no $ sizing [K]. (No source retrieved in this pass.) |
| **OptScale (Hystax)** | Open-source FinOps platform: allocation, recommendations, ML/experiment cost tracking [K; only passing mention found — S]. | Per-owner "resource assignment" and TTL rules [K]. | Heavy to self-host [K]. |
| **aws-doctor** | Go CLI/TUI: cost comparison vs previous period, 6-month trend, waste scan selectable per service (EC2, S3, CloudWatch, RDS) — orphaned EBS, unattached IPs, old snapshots; pitched as free alternative to paid Trusted Advisor [S]. | **"Doctor" metaphor — one command, one diagnosis**; comparison of this month-to-date vs same span last month [S/K]. | Small check set; HN thread devolved into AWS-is-expensive remarks [S]. |
| **Others noted** | `kosty` (PyPI, AWS waste CLI) and several "free read-only script to find wasted AWS spend" Show HN posts [S, titles only]. | **"Read-only" is the headline trust signal** for this category [S]. | — |

---

## 2. Patterns worth stealing

### Explaining "where the money goes and why"

1. **Lead with the delta, not the total.** AWS Cost Comparison auto-highlights the **top 3 drivers** of month-over-month change and hides the rest behind "View all"; the Billing home widget sorts the top 10 changes by absolute dollars and shows % and $ together [S]. Copy this exactly: three sentences, each a driver, each with $ and %.
2. **Decompose every change into rate vs usage vs one-offs.** Cost Comparison's driver categories — usage change, discount change, commitment-based savings, credits, refunds, fees [S] — are the right vocabulary. CUDOS does the same with "$/unit" charts [K]. A story like "RDS +$1,240: +$1,400 more instance-hours, −$160 from new RI coverage" is the core product moment. These come free from `GetCostComparisonDrivers`.
3. **Kill "EC2-Other".** It is a documented confusion point [S]. Always explode it into EBS volumes, snapshots, NAT gateway (hours vs bytes), data transfer, Elastic IPs/public IPv4, using usage types [K].
4. **Use amortized cost by default and say so.** Blended/unblended/amortized confusion is a named complaint [S]. Pick one (amortized, net of credits shown separately) and footnote it in plain words.
5. **Vantage-style report anatomy [K]:** one chart, one table; table rows have current, previous, Δ$, Δ%, and a sparkline; any row is clickable to drill service → usage type → (resource, when available).
6. **Separate idle from used.** Datadog/Kubecost split cost into *usage / workload idle / cluster idle* [S]. Generalize: for each service, "paid for" vs "evidently used" where the data allows.
7. **Credits and one-offs called out separately** so expiring credits do not masquerade as low spend (credits are a named driver category [S]). Add a "credits run out on …" warning [K — commonly missed].

### Anomalies

8. **Zero-config anomalies with a ranked cause list.** Reuse AWS's `GetAnomalies` (free, includes up to 10 root causes [S]) rather than inventing detection for v1; then add our own narrative.
9. **Honest math on root causes.** AWS's FAQ admits root causes do not sum to total impact [S]. Show "explained: 72% of the increase" instead of implying completeness.
10. **Alert discipline.** CloudZero caps alerts at 3/day [S]. Practitioner writing is consistent that a "5% above baseline" rule fires constantly and gets ignored within weeks, and that ownerless alerts are worse than none [S, vendor blogs]. Use a **dollar floor + percentage** threshold and show few, large anomalies. Offer "this was expected" dismissal that trains the baseline (AWS supports anomaly feedback [K]).
11. **Overlay events on spikes** (CloudZero overlays deployments [S]). For a billing-only tool, overlay what we do know: RI/SP expiry dates, credit expiry, first-seen service/region/usage type, month boundaries.

### Savings and commitments

12. **One outcome metric, benchmarked.** ProsperOps leads with ESR and your percentile [S]. Show ESR prominently with a peer band. Published ProsperOps AWS-compute benchmarks conflict by year/source: median ~15–18%, 75th pct ~23–31%, 98th pct ~46–51% [S, conflicting — cite the report year you use].
13. **Pair savings with risk.** CLR (months of lock-in) alongside ESR [S]. For every "reserve now" recommendation show: monthly saving, break-even month, lock-in term, and what happens if usage drops 20%.
14. **Commitment calendar / burndown.** Finout's commitment burndown [S], Thrifty's RI-expiration control [S], Trusted Advisor's RI lease expiration check (30 days ahead/behind [K]), Skyway's contract view [S]. A timeline of every RI/SP expiry with "$X/mo reverts to on-demand on <date>" is high value and cheap: `savingsplans:DescribeSavingsPlans`, `ec2:DescribeReservedInstances`, `rds:DescribeReservedDBInstances`, etc. [K].
15. **Actions grouped by type and effort.** Cost Optimization Hub's 8 action types [S] + effort/restart/rollback flags [K]. Group as: *Delete/Stop (free money) → Upgrade/modernize (low risk) → Rightsize (needs owner) → Commit (financial decision)*.
16. **De-duplicate savings.** COH's key idea: do not double count a rightsizing saving and an SP saving on the same instance [K]. State a single honest "total achievable" number.
17. **Savings net of existing discounts.** COH estimates savings after your actual discounts [K]; naive list-price savings overstate and destroy trust.

### Waste checklists

18. **Thrifty's plain-question phrasing** [S] and **Trusted Advisor's traffic lights with $** [S/K]. Combine: question + status + monthly $ + count of resources + one-line fix.
19. **User-tunable thresholds with sane defaults** (Thrifty variables such as `ec2_running_instance_age_max_days` [S]).
20. **Custodian's grace-period workflow** [K] as the *recommended next step text* ("tag for deletion, wait 7 days") even though CloudPennies is read-only.
21. **Modernization KPIs** (CUDOS KPI dashboard [K]; Thrifty gp2/io1/older-gen/Graviton controls [S]): show "% of EBS spend on gp3", "% of compute on Graviton", "% on current-gen" as progress bars.

### Trust, onboarding, positioning

22. **"Read-only" and "runs locally" as the headline** — the recurring trust signal in open-source tools [S]. Show the exact IAM policy and every API call made.
23. **Time-to-first-insight under minutes.** Vantage's adoption story is speed of setup [S]; CUDOS's weakness is setup weight.
24. **Show what the analysis itself costs.** Cost Explorer API is billed per request [K]; a desktop tool that silently spends dollars on API calls will get complained about. Cache aggressively and display the count.
25. **No % of savings pricing.** Explicit practitioner skepticism [S].
26. **Opinionated narrative voice** (Duckbill's style [K]): "You are paying $310/mo for 86 unattached volumes. Nobody is using them. Delete them." Recommendations fail when they are lists without a decision [S].
27. **Before/after framing** (Cast AI's free savings report [K], Infracost's diff [S]): "Current: $48.2k/mo → Achievable: $39.6k/mo".
28. **Virtual tags / perspectives** (Vantage, Finout, CloudHealth, Datadog Tag Pipelines [S]): let the user fix grouping locally (regex on account/tag/usage type) and apply it retroactively — never require re-tagging infrastructure.

---

## 3. Waste-check checklist

**Detection column legend**

- **Billing** — detectable from Cost Explorer alone (service + `UsageType` / `Operation` / purchase-type dimensions, RI/SP coverage & utilization APIs, recommendation APIs under `ce:*`). Gives *existence and dollar size* of the problem, usually not *which resource*.
- **Billing+** — billing shows the symptom and $; pinpointing the resource needs Cost Explorer resource-level data (opt-in, EC2-focused, last 14 days [K]) or CUR.
- **Resource** — needs service describe/list APIs (read-only).
- **Metrics** — needs CloudWatch metrics (or Compute Optimizer / Cost Optimization Hub doing it for you).
- **AWS-rec** — available pre-computed via Compute Optimizer / Cost Optimization Hub / Trusted Advisor APIs if the customer has opted in / has the support plan.

Usage-type strings below are **[K] — from memory; region prefixes (e.g. `USE1-`, `EUW1-`) vary and exact strings must be validated against real bills.**

Source column: **TH** = AWS Thrifty (exact, [S]); **TA** = Trusted Advisor ([K] names); **COH/CO** = Cost Optimization Hub / Compute Optimizer; **PR** = practitioner lists [S/K].

### EC2 compute

| Check | Source | Detection |
|---|---|---|
| Low-utilization / idle instances (TA: CPU ≤10% and network ≤5 MB on ≥4 of last 14 days [S third-party/K]) | TH `instances_with_low_utilization`, TA, CO/COH (Stop, Rightsize) | Metrics / AWS-rec. `ce:GetRightsizingRecommendation` gives a billing-key-only version [K] |
| Over-provisioned instances (rightsizing) | CO/COH Rightsize | AWS-rec / Metrics |
| Large instance types should be reviewed | TH `large_ec2_instances` | Billing (instance type in usage type `BoxUsage:<type>`) |
| Long-running instances (review / candidates for commitment) | TH `long_running_ec2_instances` | Resource; proxy via Billing (steady 24×7 hours on-demand) |
| Older-generation types (t2, m3, m4 …) | TH `ec2_instance_older_generation`, COH Upgrade | **Billing** (instance family in usage type) |
| Not on Graviton | TH `ec2_instance_with_graviton`, COH MigrateToGraviton | **Billing** (family) for sizing; Resource for feasibility |
| Stopped instances still accruing EBS (TA: stopped >30 days) | TA "Amazon EC2 Instances Stopped", TH `ebs_volumes_on_stopped_instances` | Resource |
| On-demand spend not covered by SP/RI | TA Savings Plan / RI Optimization, COH Purchase* | **Billing** (`GetSavingsPlansCoverage`, `GetReservationCoverage`, `Get*PurchaseRecommendation`) |
| RI / SP under-utilized (paying for unused commitment) | PR | **Billing** (`GetSavingsPlansUtilization`, `GetReservationUtilization`) |
| RIs / SPs expiring soon or recently expired | TH `ec2_reserved_instance_lease_expiration_days`, TA "RI Lease Expiration" | Resource (describe RIs / SPs — cheap, read-only); Billing shows the after-effect (coverage drop) |
| Windows/SQL Server licence over-provisioning, SQL consolidation | TA (2 checks) | Resource / AWS-rec |
| ASG rightsizing / idle ASG (ScaleIn) | CO/COH | AWS-rec |
| No Spot usage on fault-tolerant workloads | PR | Billing (zero `SpotUsage`) as a prompt only |
| Dedicated hosts / tenancy premium, unused capacity reservations (ODCR) | PR | Billing (`DedicatedUsage`, `UnusedBox`/`UnusedDed` usage types) |
| Detailed monitoring, T-family unlimited CPU credits surcharge | PR | **Billing** (`CPUCredits:*` usage type; CW metric charges) |

### EBS & snapshots

| Check | Source | Detection |
|---|---|---|
| gp2 → gp3 | TH `gp2_volumes`, COH Upgrade | **Billing** (`EBS:VolumeUsage.gp2`) — $ saving computable (~20% [K]) |
| io1 → io2 | TH `io1_volumes`, COH Upgrade | **Billing** (`EBS:VolumeUsage.piops`, `EBS:VolumeP-IOPS.piops`) |
| Unattached volumes | TH `unattached_ebs_volumes`, TA "Underutilized EBS Volumes", CO idle | Resource |
| Volumes attached to stopped instances | TH `ebs_volumes_on_stopped_instances` | Resource |
| Oversized volumes | TH `large_ebs_volumes` | Resource |
| High provisioned IOPS that should be reduced | TH `high_iops_ebs_volumes` | Resource; Billing shows IOPS/throughput line items (`EBS:VolumeP-IOPS.gp3`, `EBS:VolumeP-Throughput.gp3`) |
| Provisioned-IOPS volumes that would be fine as gp3 | TH `low_iops_ebs_volumes` | Resource |
| Low-usage volumes (little I/O) | TH `ebs_with_low_usage`, TA | Metrics |
| Over-provisioned volumes | TA "Amazon EBS over-provisioned volumes", CO | AWS-rec |
| Old snapshots | TH `ebs_snapshot_max_age` | Resource; **Billing** shows total (`EBS:SnapshotUsage`) and its trend |
| Snapshots whose source volume no longer exists | TH `ebs_unused_snapshots` | Resource |
| Snapshot archive tier not used; AMIs never deregistered; Fast Snapshot Restore left on | PR | Billing (`EBS:SnapshotArchiveStorage`, `EBS:FastSnapshotRestore`) / Resource |

### Load balancing & networking

| Check | Source | Detection |
|---|---|---|
| ALB / NLB / GWLB / CLB with no targets | TH `ec2_application_lb_unused`, `ec2_network_lb_unused`, `ec2_gateway_lb_unused`, `ec2_classic_lb_unused` | Resource |
| Idle load balancers (few requests in 7 days) | TA "Idle Load Balancers" | Metrics; **Billing proxy**: `LoadBalancerUsage` hours with ~zero `LCUUsage`/`DataProcessing-Bytes` |
| Unattached Elastic IPs | TH `unattached_eips`, TA "Unassociated Elastic IP Addresses" | **Billing** (`PublicIPv4:IdleAddress`; legacy `ElasticIP:IdleAddress`) |
| Public IPv4 charge overall (since Feb 2024, $0.005/hr each [S]) | PR | **Billing** (`PublicIPv4:InUseAddress`) |
| Unused / inactive NAT gateways | TH `vpc_nat_gateway_unused`, TA "Inactive NAT Gateways", COH [K?] | Metrics; **Billing proxy**: `NatGateway-Hours` with ~zero `NatGateway-Bytes` |
| NAT gateway data-processing heavy (should use VPC endpoints for S3/DynamoDB/ECR) | PR | **Billing** (`NatGateway-Bytes` large vs hours) |
| Inactive VPC interface endpoints | TA | Metrics; Billing proxy (`VpcEndpoint-Hours` with ~zero `VpcEndpoint-Bytes`) |
| Inactive AWS Network Firewall | TA | Metrics / Billing proxy |
| Cross-AZ data transfer | PR, CUDOS Data Transfer | **Billing** (`DataTransfer-Regional-Bytes`) |
| Inter-region transfer | PR, CUDOS | **Billing** (`<SRC>-<DST>-AWS-Out-Bytes`) |
| Internet egress that should be behind CloudFront | PR | **Billing** (`DataTransfer-Out-Bytes`) |
| Idle Transit Gateway attachments, Site-to-Site VPN connections, Client VPN endpoints, Direct Connect ports | PR | Billing proxy (hours with no bytes) |
| Route 53 records with low TTL; unused health checks | TH `route53_record_higher_ttl`, `route53_health_check_unused` | Resource; Billing shows health-check count |
| Route 53 latency record sets misconfigured | TA | Resource |
| CloudFront price class should be reviewed | TH `cloudfront_distribution_pricing_class` | Resource; Billing shows expensive-edge-region usage |

### RDS / Aurora / other databases

| Check | Source | Detection |
|---|---|---|
| Idle DB instances (no connections 7 days) | TA "Amazon RDS Idle DB Instances", TH `rds_db_low_connection_count`, CO/COH | Metrics / AWS-rec |
| Low CPU utilization | TH `rds_db_low_utilization`, CO Rightsize | Metrics / AWS-rec |
| Long-running DBs without reserved instances | TH `long_running_rds_db_instances`, TA "RDS RI Optimization", COH | **Billing** (`GetReservationCoverage` / purchase recommendation for RDS) |
| Previous-generation instance classes | TH `latest_rds_instance_types` | **Billing** (class in `InstanceUsage:db.<class>`) |
| Not on Graviton | TH `rds_db_instance_with_graviton`, COH | **Billing** (class) |
| **MySQL/PostgreSQL on unsupported major version → Extended Support surcharge** (auto-enrolled, billed per vCPU-hour [S]) | TH `rds_mysql_postresql_db_no_unsupported_version` | **Billing** (usage type contains `ExtendedSupport` [K — verify string]) |
| Snapshots without a source DB instance | TH `rds_unused_snapshots` | Resource; Billing shows backup storage (`RDS:ChargedBackupUsage`) |
| RDS storage over-provisioned; gp2 → gp3; provisioned IOPS unused | COH (RdsDbInstanceStorage) [K] | AWS-rec; **Billing** for gp2 (`RDS:GP2-Storage`) and PIOPS |
| Aurora cluster storage: Standard vs I/O-Optimized mismatch | COH (AuroraDbClusterStorage) [S], TA | AWS-rec; **Billing** heuristic: Aurora I/O charges >~25% of Aurora spend → I/O-Optimized likely cheaper [K] |
| Multi-AZ on non-production | PR | Billing (`Multi-AZUsage`) + account/tag context |
| DynamoDB tables without autoscaling | TH `dynamodb_table_without_autoscaling` | Resource |
| DynamoDB tables with stale data | TH `stale_dynamodb_table_data` | Resource |
| DynamoDB idle provisioned tables | CO (June 2026) [S] | AWS-rec |
| DynamoDB reserved capacity; on-demand vs provisioned mismatch; Standard-IA table class | COH (DynamoDbReservedCapacity) [K], PR | Billing (read/write request units vs capacity-unit hours) |
| ElastiCache long-running without reserved nodes | TH `elasticache_cluster_long_running`, TA "ElastiCache Reserved Node Optimization" | **Billing** |
| ElastiCache / MemoryDB / DocumentDB idle | CO (June 2026) [S] | AWS-rec |
| Redshift long-running without reserved nodes | TH `redshift_cluster_max_age`, TA "Redshift Reserved Node Optimization" | **Billing** |
| Redshift without pause/resume schedule | TH `redshift_cluster_schedule_pause_resume_enabled` | Resource |
| Redshift low utilization | TH `redshift_cluster_low_utilization`, TA "Underutilized Amazon Redshift Clusters" | Metrics |
| OpenSearch RI optimization | TA | **Billing** |
| Database Savings Plans coverage (new, re:Invent 2025 [S secondary]) | PR | Billing (SP coverage APIs) [?] |

### S3

| Check | Source | Detection |
|---|---|---|
| Buckets without lifecycle policy | TH `buckets_with_no_lifecycle`, TA "S3 Bucket Lifecycle Policy Configured" | Resource |
| No rule to abort incomplete multipart uploads | TA "S3 Incomplete Multipart Upload Abort Configuration" | Resource (Storage Lens for size) |
| Versioned buckets without noncurrent-version expiry | TA | Resource |
| All storage in Standard (no IA / Intelligent-Tiering / Glacier) | PR | **Billing** (`TimedStorage-ByteHrs` vs `-SIA-`, `-INT-`, `-GlacierByteHrs` mix) |
| Request / retrieval / early-delete fees dominating | PR | **Billing** (`Requests-Tier1/2`, `Retrieval-*`, `EarlyDelete-*`) |
| Intelligent-Tiering monitoring fee on tiny objects; replication and transfer-acceleration charges | PR | **Billing** |

### Containers, serverless, analytics

| Check | Source | Detection |
|---|---|---|
| ECR repos with unused images / no lifecycle policy | TH `ecr_repository_unused_images`, TA "ECR Repository Without Lifecycle Policy" | Resource; Billing shows `TimedStorage-ByteHrs` (ECR) trend |
| ECS cluster low CPU utilization | TH `ecs_cluster_low_utilization` | Metrics |
| ECS service without autoscaling | TH `ecs_service_without_autoscaling` | Resource |
| ECS container instances / EKS node groups not on Graviton | TH `ecs_cluster_container_instance_with_graviton`, `eks_node_group_with_graviton` | Resource; Billing for Fargate (`Fargate-vCPU-Hours` vs `Fargate-ARM-vCPU-Hours`) |
| ECS-on-Fargate service rightsizing | CO/COH (EcsService) | AWS-rec |
| **EKS extended support surcharge** ($0.60/cluster-hour vs $0.10 [S]) | PR | **Billing** (EKS usage type with `ExtendedSupport` [K — verify]) |
| Lambda excessive timeout | TH `lambda_function_excessive_timeout`, TA | Resource/Metrics |
| Lambda high error rate | TH `lambda_function_high_error_rate`, TA | Metrics |
| Lambda not on Graviton | TH `lambda_function_with_graviton` | Resource; **Billing** (`Lambda-GB-Second` vs `Lambda-GB-Second-ARM`) |
| Lambda over-provisioned memory | TA, CO/COH | AWS-rec |
| Lambda provisioned concurrency unused | PR | Billing (`Lambda-Provisioned-Concurrency`) + Metrics |
| EMR previous-gen instances | TH `emr_cluster_instance_prev_gen` | Resource / Billing |
| EMR idle > 30 minutes | TH `emr_cluster_is_idle_30_minutes` | Metrics |
| API Gateway stage with caching disabled | TH `apigateway_stage_with_caching_disabled` | Resource (note: enabling cache *adds* cost; framing matters) |
| Comprehend underutilized endpoints | TA | Metrics |
| SageMaker idle endpoints; idle notebooks | CO (June 2026) [S], PR | AWS-rec / Billing (endpoint-hours steady, no invocations) |
| WorkSpaces idle | CO (June 2026) [S] | AWS-rec |
| Bedrock / AI spend growth, provisioned throughput idle | PR | **Billing** |

### Observability, security, management

| Check | Source | Detection |
|---|---|---|
| CloudWatch log groups with no retention ("Never expire" default [S]) | TH `cw_log_group_retention` | Resource; **Billing** shows stored-bytes growth (`TimedStorage-ByteHrs` under CloudWatch) |
| Unused log streams | TH `cw_log_stream_unused` | Resource |
| CloudWatch Logs **ingestion** dominating | PR | **Billing** (`DataProcessing-Bytes`; vended logs `VendedLog-Bytes`) |
| Custom metrics / high-res metrics / alarms / dashboards / `GetMetricData` API spend | PR | **Billing** (`CW:MetricMonitorUsage`, `CW:AlarmMonitorUsage`, `CW:Requests`, `CW:GMD-Metrics`) |
| Redundant CloudTrail trails (global and regional) | TH `multiple_global_trails`, `multiple_regional_trails` | Resource; **Billing** (`PaidEventsRecorded` > 0 means duplicate management-event trails) |
| CloudTrail data events, AWS Config recorder churn, GuardDuty/Inspector/Security Hub/Macie growth | PR | **Billing** (`ConfigurationItemRecorded`, etc.) |
| Unused Secrets Manager secrets | TH `secretsmanager_secret_unused` | Resource |
| KMS customer keys never used; excessive KMS requests (no S3 Bucket Keys) | PR | Billing (key count, `KMS-Requests`) / Resource |
| Well-Architected high-risk issues for cost | TA | AWS-rec |

### Account / bill level

| Check | Source | Detection |
|---|---|---|
| "What services changed in cost over the last two months?" | TH `full_month_cost_changes`, CE Cost Comparison | **Billing** |
| New service / region / account / usage type first seen this month | PR | **Billing** |
| Spend in unexpected regions | PR | **Billing** |
| Untagged / unallocated spend % | FinOps KPI [S] | **Billing** (tag group-by with empty key) |
| Credits expiring / credits masking true run-rate | PR | **Billing** (record type = Credit) |
| Support plan cost as % of bill; tax; Marketplace subscriptions | PR, CUDOS (Marketplace section [S]) | **Billing** |
| Forecast vs budget breach | CE, Budgets | **Billing** (`GetCostForecast`) |
| EDP / private pricing commitment burn-down | Skyway [S] | User-entered contract + Billing |

### Reference lists (verify before relying on)

**AWS Thrifty — exact control inventory [S: pulled from mod source, `main` branch, 2026-11-18]** — 55 controls in 20 files: API Gateway (1), CloudFront (1), CloudTrail (2), CloudWatch (2), Cost Explorer (1), DynamoDB (2), EBS (10), EC2 (10), ECR (1), ECS (3), EKS (1), ElastiCache (1), EMR (2), Lambda (3), Network (2), RDS (7), Redshift (3), Route 53 (2), S3 (1), Secrets Manager (1). Every control ID appears in the tables above.

**Trusted Advisor cost-optimization checks [K — from memory; AWS docs unreachable in this pass]:** Amazon Comprehend Underutilized Endpoints · Amazon EBS over-provisioned volumes · Amazon EC2 instances consolidation for Microsoft SQL Server · Amazon EC2 instances over-provisioned for Microsoft SQL Server · Amazon EC2 Instances Stopped · Amazon EC2 Reserved Instance Lease Expiration · Amazon EC2 Reserved Instances Optimization · Amazon ECR Repository Without Lifecycle Policy Configured · Amazon ElastiCache Reserved Node Optimization · Amazon OpenSearch Service Reserved Instance Optimization · Amazon RDS Idle DB Instances · Amazon Redshift Reserved Node Optimization · Amazon RDS Reserved Instance Optimization · Amazon Route 53 Latency Resource Record Sets · Amazon S3 Bucket Lifecycle Policy Configured · Amazon S3 Incomplete Multipart Upload Abort Configuration · Amazon S3 version-enabled buckets without lifecycle policies configured · AWS Lambda Functions with Excessive Timeouts · AWS Lambda Functions with High Error Rates · AWS Lambda over-provisioned functions for memory size · AWS Well-Architected high risk issues for cost optimization · Idle Load Balancers · Inactive AWS Network Firewall · Inactive NAT Gateways · Inactive VPC interface endpoints · Low Utilization Amazon EC2 Instances · Savings Plan · Unassociated Elastic IP Addresses · Underutilized Amazon EBS Volumes · Underutilized Amazon Redshift Clusters · plus a family of newer "cost savings action identified by Cost Optimization Hub" checks per resource type (Aurora cluster storage and DynamoDB confirmed [S]).

**Cost Optimization Hub [S for action types; K for resource types]:**
- Action types: `Rightsize`, `Stop`, `Upgrade`, `PurchaseSavingsPlans`, `PurchaseReservedInstances`, `MigrateToGraviton`, `Delete`, `ScaleIn` [S].
- Purchase coverage: reservations for EC2, RDS, OpenSearch, Redshift, ElastiCache, MemoryDB, DynamoDB; Savings Plans for Compute, EC2 Instance, SageMaker [S].
- Resource types [K]: Ec2Instance, Ec2AutoScalingGroup, EbsVolume, LambdaFunction, EcsService, RdsDbInstance, RdsDbInstanceStorage, AuroraDbClusterStorage [S], ComputeSavingsPlans, Ec2InstanceSavingsPlans, SageMakerSavingsPlans, Ec2ReservedInstances, RdsReservedInstances, OpenSearchReservedInstances, RedshiftReservedInstances, ElastiCacheReservedInstances, MemoryDbReservedInstances, DynamoDbReservedCapacity, NatGateway [?]. FAQ says "18 types" [S].

### What a billing-only key can realistically cover

With only `ce:*` (plus optionally `savingsplans:Describe*`, `ec2:DescribeReservedInstances` and siblings, `cost-optimization-hub:*`, `compute-optimizer:Get*`):

- **Fully covered:** spend breakdown and drivers; anomalies; forecasts; commitment coverage/utilization/ESR; purchase recommendations; expirations; all modernization checks that are visible in usage types (gp2, io1, old instance families, non-Graviton share, storage-class mix); all "pure billing" leaks (idle public IPv4, extended support, NAT bytes, data transfer, log ingestion, CloudTrail duplicates, credits).
- **Symptom only, no resource names:** unattached volumes, old snapshots, idle load balancers/NAT/endpoints (hours-with-no-bytes heuristic).
- **Free upgrade if the customer opted in:** Cost Optimization Hub and Compute Optimizer return named resources with savings — no need for our own metric analysis.
- **Not possible:** anything needing configuration (lifecycle policies, autoscaling, retention settings) or CloudWatch metrics, unless optional read-only resource permissions are granted.

Suggested product structure: **Tier 1 billing-only (default) → Tier 2 "connect AWS recommendations" (COH/CO) → Tier 3 optional read-only resource scan (Thrifty-equivalent).**

---

## 4. Key metrics a FinOps lead expects

| Metric | Definition | Notes |
|---|---|---|
| **Effective Savings Rate (ESR)** | `(On-Demand Equivalent spend − actual spend on the same usage) ÷ On-Demand Equivalent spend`. FinOps Foundation phrasing: (RI & SP savings − cost to achieve them) ÷ ODE spend [S]. Shortcut: utilization × coverage × discount (e.g. 90% × 100% × 50% = 45%) [S]. | The single best "how good are we at rates" number. Benchmarks (ProsperOps, AWS compute; sources conflict by year): median ≈15–18%, 75th pct ≈23–31%, 98th pct ≈46–51% [S]. Computable from Cost Explorer. |
| **Commitment coverage** | Commitment-covered spend (or hours) ÷ eligible on-demand-equivalent spend [S]. | High coverage + low utilization = over-committed [S]. Report per family: compute SP, EC2 RI, RDS, ElastiCache, OpenSearch, Redshift, DynamoDB. |
| **Commitment utilization** | Used commitment ÷ purchased commitment. | Vendor target ≥90% [S, vendor]. Unused commitment is sunk cost. |
| **Commitment Lock-In Risk (CLR)** | Weighted average remaining duration of the commitment portfolio in months: Σ(remaining months × commitment value) ÷ Σ(commitment value); ProsperOps defines CLR as the maximum of that over time assuming renewals [S: nOps description of ProsperOps metric]. | Lower is safer. Single 3-yr SP ⇒ 36 months [S]. |
| **Commitment expirations** | Commitments ending in next 30/60/90 days and the on-demand $ they revert to. | TA and Thrifty both check this [S/K]. |
| **Unit cost / unit economics** | Cloud cost ÷ business unit (customer, order, request, GB, active user) [S]. | Target: flat or falling as volume grows [S, vendor]. Billing-only fallback: let the user type a monthly denominator (revenue, customers) to get cost-per-X and cloud-spend-as-%-of-revenue. |
| **Forecast accuracy / variance** | Accuracy = 1 − \|actual − forecast\| ÷ forecast [S, vendor]; variance = (actual − forecast) ÷ forecast, signed. | FinOps Foundation: forecast vs actual within an agreed variance threshold [S]. Vendor targets range from >90% accuracy to "within 20%" [S]. Track our own forecast's past accuracy and show it — it builds trust. |
| **Budget variance** | (Actual − budget) ÷ budget; plus projected month-end vs budget. | |
| **Allocation coverage / unallocated %** | Spend attributable to an owner ÷ total spend. Untagged cost % = cost of untagged resources ÷ total (or ÷ taggable) spend [S: FinOps Foundation KPI]. | Maturity benchmark often cited: ~50% allocated at "crawl", 90%+ at "run" [S, via vendor blog — unverified]. |
| **Waste / unused-resource %** | Cost of idle/unused resources ÷ total spend. FinOps Foundation lists "Percent of Unused Resources" (unattached volumes, load balancers, EIPs…) [S]. | Headline candidate: "X% of your bill is waste". |
| **Realized vs potential savings** | Savings captured this period vs identified opportunity outstanding. | AWS's 2026 "Cost Efficiency" widget appears to be in this family [?]. A good formulation: 1 − (potential savings ÷ optimizable spend). |
| **Rightsizing opportunity** | Estimated monthly savings from rightsizing ÷ compute spend. | From CO/COH. |
| **Modernization adoption** | % of EBS spend on gp3; % compute on Graviton; % on current-gen families; % of S3 outside Standard. | CUDOS KPI dashboard pattern [K]; all billing-derivable. |
| **Purchase-option mix** | Share of compute by On-Demand / SP / RI / Spot. | Billing-derivable. |
| **MoM / period-over-period change with drivers** | Δ$ and Δ% decomposed into usage, rate, credits/one-offs. | Cost Comparison categories [S]. |
| **Run rate** | Trailing daily average × days in month (and annualized). | Always show beside the forecast. |
| **Anomaly metrics** | Count, total $ impact, time to detect, time to resolve. | FinOps "Manage Anomalies" capability [S, page not opened]. |
| **Data-transfer share** | Transfer cost ÷ total; split internet / inter-region / inter-AZ / NAT. | CUDOS Data Transfer dashboard pattern [S]. |
| **Amortized vs unblended cost** | Amortized spreads upfront commitment fees over the term; unblended is cash-basis as billed. | Must state which one each chart uses [K]. |

**FinOps Framework reporting guidance (summary [K, framework pages not opened in this pass]):** reports should be timely, tailored to persona (executive: trend, forecast, unit cost, KPIs; engineering: their own resources and actions; finance: budget/forecast variance and amortized cost), and should connect cost to business value via unit economics. Maturity is "crawl / walk / run" — a billing-only tool serves crawl-to-walk organizations well, which matches the CloudPennies target user.

---

## 5. What practitioners complain about (themes)

Evidence quality is mixed; primary threads could not be opened.

1. **Cost Explorer shows data, not answers.** "EC2-Other", blended costs, and navigation confuse people [S: Vantage blog, G2].
2. **Recommendations do not turn into action.** Friction between recommendation and execution; lists without owner, risk, or effort [S].
3. **Alert fatigue.** Percentage-only thresholds fire constantly; ownerless alerts are ignored [S, vendor blogs; one r/FinOps thread on balancing false positives].
4. **Pricing models.** % of savings fees outlive the easy wins [S]; % of spend / spend-tier pricing with opaque renewals (CloudHealth) [S].
5. **Setup weight and time-to-value.** Multi-account setup slower than expected, reports hard to customize, slow on large data, expertise required [S: Finout page on tools generally]; CUDOS needs CUR + Athena + QuickSight [K].
6. **Tagging is never finished.** Hence virtual tags everywhere [S].
7. **Trust and access.** Reluctance to give third-party SaaS broad access; "read-only" and local execution are selling points [S].
8. **Savings numbers overstated.** List-price savings, double counting, CPU-only rightsizing [K].
9. **Tool sprawl / the tool's own cost.** Paying a FinOps tool a percentage of the bill to tell you the bill is high [K].

---

## 6. Sources

Primary/official (many not directly fetchable from the research sandbox; content taken from search-result extracts unless marked *fetched*):

- AWS Thrifty mod source (*fetched*, exact control list): https://github.com/turbot/steampipe-mod-aws-thrifty — control files under `/controls/*.pp`; hub page https://hub.powerpipe.io/mods/turbot/aws_thrifty/controls
- AWS Cost Explorer Cost Comparison announcement (May 2025): https://aws.amazon.com/about-aws/whats-new/2025/05/aws-cost-explorer-new-cost-comparison-feature
- Cost Comparison docs: https://docs.aws.amazon.com/cost-management/latest/userguide/ce-cost-comparison.html · https://docs.aws.amazon.com/cost-management/latest/userguide/ce-understand-cost-comparison.html
- GetCostComparisonDrivers API: https://docs.aws.amazon.com/aws-cost-management/latest/APIReference/API_GetCostComparisonDrivers.html
- AWS blog, Quick MoM cost analysis: https://aws.amazon.com/blogs/aws-cloud-financial-management/quick-mom-cost-analysis-with-aws-cost-explorers-new-cost-comparison-feature
- Cost Anomaly Detection root cause (Nov 2024): https://aws.amazon.com/about-aws/whats-new/2024/11/aws-enhanced-root-cause-insights-cost-anomalies
- Cost Anomaly Detection managed monitors (Nov 2025): https://aws.amazon.com/about-aws/whats-new/2025/11/aws-cost-anomaly-detection-managed-monitoring
- Cost Anomaly Detection FAQ: https://aws.amazon.com/aws-cost-management/aws-cost-anomaly-detection/faqs
- Cost Optimization Hub docs: https://docs.aws.amazon.com/cost-management/latest/userguide/cost-optimization-hub.html · strategies: https://docs.aws.amazon.com/cost-management/latest/userguide/coh-optimization-strategies.html · FAQ: https://aws.amazon.com/aws-cost-management/cost-optimization-hub/faqs/
- Compute Optimizer supported resources: https://docs.aws.amazon.com/compute-optimizer/latest/ug/supported-resources.html
- Compute Optimizer six new idle types (June 2026): https://aws.amazon.com/about-aws/whats-new/2026/06/aws-compute-optimizer-six-new-idle
- Compute Optimizer 32-day lookback (June 2026): https://aws.amazon.com/about-aws/whats-new/2026/06/aws-compute-optimizer-ebs-ecs-32-day-lookback/
- Trusted Advisor cost optimization checks (not opened; verify list here): https://docs.aws.amazon.com/awssupport/latest/user/cost-optimization-checks.html
- Trusted Advisor + Cost Optimization Hub checks blog: https://aws.amazon.com/blogs/aws-cloud-financial-management/optimize-your-aws-spend-with-new-cost-savings-features-in-aws-trusted-advisor/
- Cloud Intelligence Dashboards: https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/dashboards.html · https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html · https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/trusted-advisor-dashboard.html
- Cost Efficiency widget (July 2026): https://aws.amazon.com/about-aws/whats-new/2026/07/monitor-cost-efficiency-using-dashboards/
- Budgets widget (May 2026): https://aws.amazon.com/about-aws/whats-new/2026/05/monitor-aws-budgets-using-dashboards
- Cost Explorer historical retention for billing groups (June 2026): https://aws.amazon.com/about-aws/whats-new/2026/06/aws-cost-explorer/
- re:Invent 2025 CFM announcements: https://aws.amazon.com/blogs/aws-cloud-financial-management/reinvent-2025-hidden-cfm-announcements-guide · recap https://www.prosperops.com/blog/aws-reinvent-2025-recap-unlocking-cost-efficiency-in-the-cloud/ · COP203 notes https://dev.to/kazuya_dev/aws-reinvent-2025-whats-new-with-aws-cost-management-cop203-3ofd
- FinOps Foundation KPI — untagged cost: https://www.finops.org/kpi/percentage-of-costs-associated-with-untagged-csp-cloud-resources/
- FinOps Foundation — Manage Anomalies: https://www.finops.org/framework/capabilities/manage-anomalies/
- FinOps Foundation — Unit Economics (not opened): https://www.finops.org/framework/capabilities/unit-economics/

Vendor pages:

- ProsperOps ESR: https://www.prosperops.com/effective-savings-rate/ · ESR benchmark in console: https://www.prosperops.com/blog/esr-benchmark-in-prosperops-console/ · CLR: https://www.prosperops.com/blog/introducing-commitment-lock-in-risk/ · 2024 benchmark: https://www.prosperops.com/library/2024-aws-compute-effective-savings-rate-esr-benchmarking-insights/
- nOps on CLR and ESR: https://www.nops.io/blog/commitment-lock-in-risk/ · https://www.nops.io/blog/effective-savings-rate/
- Vantage: https://www.vantage.sh/features · https://www.vantage.sh/blog/beyond-aws-cost-explorer · https://www.vantage.sh/blog/vantage-launches-virtual-tagging · https://docs.vantage.sh/changelog.md (not opened)
- Vantage reviews: https://www.g2.com/products/vntg-inc-vantage/reviews
- CloudZero anomalies: https://www.cloudzero.com/platform/anomalies/ · https://docs.cloudzero.com/docs/anomaly-detection · https://docs.cloudzero.com/docs/notifications · Slack: https://www.cloudzero.com/integration/slack/
- CloudZero on alternatives (CloudHealth, Vantage, Cost Explorer): https://www.cloudzero.com/blog/cloudhealth-alternatives/ · https://www.cloudzero.com/blog/vantage-alternatives/ · https://www.cloudzero.com/blog/aws-cost-explorer-alternatives
- Datadog CCM: https://docs.datadoghq.com/cloud_cost_management/ · Tag Pipelines: https://docs.datadoghq.com/cloud_cost_management/tags/tag_pipelines/
- Finout: https://www.finout.io/blog/finout-vs.-cloudzero-vs.-ternary-the-2026-comparison-guide · https://finout.io/virtual-tagging · https://www.finout.io/blog/vmware-cloudhealth-overview · KPIs: https://www.finout.io/blog/cloud-cost-health-metrics-15-kpis-every-finops-team-should-track
- Finout reviews: https://www.gartner.com/reviews/product/finout · https://www.peerspot.com/products/finout-reviews
- Kubecost / OpenCost: https://www.nops.io/blog/kubecost-vs-opencost/ · https://cast.ai/blog/opencost-vs-kubecost/ · https://devopsboys.com/blog/kubecost-opencost-kubernetes-cost-review-2026
- nOps / Cast AI / Spot / Zesty comparisons: https://spendark.com/blog/spot-io-vs-cast-ai-vs-nops/ · https://www.nops.io/blog/cast-ai-alternatives/ · https://www.nops.io/blog/top-zesty-alternatives/
- CloudHealth: https://amnic.com/blogs/cloudhealth-alternatives · https://spendark.com/blog/cloudhealth-alternative/ · https://docs.broadcom.com/doc/451-research-vmware-tanzu-cloudhealth-tooled-up-to-support-new-finops-experience
- Duckbill Skyway: https://www.geekwire.com/2026/cloud-and-aws-cost-consultant-duckbill-expands-to-software-raises-7-75m-for-new-skyway-platform/ · https://www.heavybit.com/press/heavybit-welcomes-new-member-duckbill · https://www.finops.org/members/duckbill/
- Infracost: https://infracost.io/ · https://github.com/infracost/actions · https://www.infracost.io/blog/dec-2022-update/
- aws-doctor: https://github.com/elC0mpa/aws-doctor · HN thread id 46675092 (https://news.ycombinator.com/item?id=46675092)
- Komiser: https://medium.com/@mlabouardy/komiser-optimize-cost-and-security-on-aws-183174ba58c5

Practitioner / commentary:

- "Cost Explorer isn't the answer": https://dev.to/brianpregan/cost-explorer-isnt-the-answer-18o0
- Cost Explorer limitations (vendor): https://holori.com/aws-cost-explorer-limitations/
- FinOps KPIs (vendor): https://holori.com/finops-kpis-and-metrics-what-to-measure-and-when/ · https://cloudaware.com/blog/finops-kpis/ · https://www.doit.com/blog/finops-kpis/
- Anomaly alert noise: https://www.pointfive.co/blog/waking-up-to-a-cloud-bill-shock-why-native-alerts-fail · https://www.finout.io/blog/cloud-cost-anomaly-detection-tips · https://dev.to/angela_gupta/prioritizing-cloud-cost-anomalies-what-deserves-your-attention-3aib
- Cost Anomaly Detection limits (third-party): https://ecorpit.com/aws-cost-anomaly-detection-bedrock-third-party-models-docs-conflict-2026/
- Hidden AWS costs: https://dev.to/hoangleitvn/12-hidden-aws-costs-that-silently-drain-your-budget-46f2 · https://nops.io/blog/6-hidden-aws-costs-that-might-be-driving-up-your-bill · https://www.cloudkeeper.com/insights/blog/aws-cost-optimization-not-just-right-sizing-finding-hidden-infrastructure-waste
- Trusted Advisor guides (third-party thresholds): https://www.nops.io/blog/aws-trusted-advisor-comprehensive-guide · https://www.prosperops.com/blog/aws-trusted-advisor/ · https://oneuptime.com/blog/post/2026-02-12-use-trusted-advisor-for-cost-optimization-recommendations/view
- AWS FinOps update roundups: https://finopsweekly.com/news/aws-cost-optimization-finops-updates/
