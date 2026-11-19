# Cost and Usage Report: resource-level cost with history

Cost Explorer only keeps cost **per resource** (this instance, that bucket) for the last 14 days.
The Cost and Usage Report (CUR) that AWS delivers to an S3 bucket has it for every month.
When an export exists, CloudPennies reads it during a scan and keeps a compact copy on this
computer, so that "which resources is this money going to?" can be answered for whole months,
without any Cost Explorer request (and so without the $0.01 per request).

Everything else in the app (briefing, anomalies, savings) keeps using Cost Explorer.

## What you need

1. A **Data Export** (CUR 2.0) or a legacy Cost and Usage Report **with resource IDs**.
2. Read access for CloudPennies to the export definition and to the S3 bucket it delivers to.

If no export exists, nothing breaks: scans show a note and resource-level views stay limited to 14 days.

## Create a Data Export

In the management (payer) account:

1. Open **Billing and Cost Management → Data Exports** and choose **Create**.
2. Export type: **Standard data export**.
3. Data table: **CUR 2.0**.
4. Under the table configuration, switch on **Include resource IDs**. This is the setting that
   matters: without it the export contains nothing Cost Explorer does not already have, and
   CloudPennies will not use it.
5. Time granularity: **Daily** or **Hourly**. Both work. Daily files are much smaller; choose
   hourly only if you need it elsewhere.
6. Columns: keep the default selection (all columns). CloudPennies needs at least
   `line_item_usage_start_date`, `line_item_line_item_type`, `line_item_unblended_cost` and
   `line_item_resource_id`; the amortized cost bases also use the `savings_plan_*` and
   `reservation_*` columns.
7. Compression type and file format: **Parquet**. (gzip CSV also works, but is larger and slower.)
8. File versioning: **Overwrite existing data export file** keeps the bucket small. "Create new" works too.
9. Choose (or create) the S3 bucket and a prefix, and let the console apply the bucket policy it proposes.

Things to know:

- **The first delivery takes up to 24 hours.** Until then CloudPennies reports that it found no files.
- **History is not backfilled automatically.** A new export starts with the current month. Earlier
  months can be requested from AWS Support (a backfill request for the export); they appear in the
  same bucket and are picked up by the next scan.
- AWS refreshes the current month at least once a day, and re-delivers a closed month when the bill
  is finalized or corrected. CloudPennies notices and imports that month again.

### Legacy Cost and Usage Reports

An existing legacy report (Billing → Cost and Usage Reports) works as long as **Include resource IDs**
is on and the format is **Parquet** or **GZIP**-compressed CSV. ZIP-compressed reports are not read.
When both kinds exist, CloudPennies prefers CUR 2.0 over legacy and Parquet over CSV; you can pick a
specific export in Settings.

## Permissions

Add these statements to the CloudPennies policy (`docs/IAM_POLICY.json` contains them; replace
`YOUR-CUR-BUCKET` with the bucket of the export):

```json
{
  "Sid": "CloudPenniesCostAndUsageReport",
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:ListBucket"],
  "Resource": ["arn:aws:s3:::YOUR-CUR-BUCKET", "arn:aws:s3:::YOUR-CUR-BUCKET/*"]
},
{
  "Sid": "CloudPenniesCostAndUsageReportList",
  "Effect": "Allow",
  "Action": ["bcm-data-exports:ListExports", "bcm-data-exports:GetExport", "cur:DescribeReportDefinitions"],
  "Resource": "*"
}
```

| Permission | Why |
| --- | --- |
| `bcm-data-exports:ListExports`, `bcm-data-exports:GetExport` | find Data Exports (CUR 2.0) and where they deliver |
| `cur:DescribeReportDefinitions` | find legacy reports |
| `s3:ListBucket` | find a month's files, their sizes and whether they changed |
| `s3:GetObject` | read the manifest and the data files |

All of it is read-only. The S3 access is limited to the one bucket. If the bucket belongs to another
account, its bucket policy must allow the CloudPennies user or role as well; if the objects are
encrypted with a customer-managed KMS key, that key must allow `kms:Decrypt`.

When a permission is missing, the scan still succeeds and shows one warning that names it.

## What it costs

Reading the report is ordinary S3 usage, billed to the account that owns the CloudPennies credentials:
a few list requests and one GET per data file per changed month, plus data transfer out to the
internet for the files (the first 100 GB per month are free on AWS at the time of writing). Closed
months are downloaded once; the current month is downloaded again only when AWS has refreshed it.
For most accounts this is a few cents a month or less. A month whose files exceed 3 GB compressed
is skipped with a warning rather than downloaded.

Storing the export in S3 is billed by AWS as usual, whether or not CloudPennies reads it.

## Where the data is kept

Imported months are stored on this computer only, under the app's data directory:

```
<userData>/cache/cur/<account id>/<export id hash>/
    2026-11.json.gz     one file per billing month (aggregated, gzip)
    index.json          imported months, source fingerprints, cost basis
    services.json       usage type → Cost Explorer service names
```

(`<userData>` is `~/Library/Application Support/CloudPennies` on macOS, `%APPDATA%\CloudPennies` on
Windows and `~/.config/CloudPennies` on Linux.) Downloads pass through a temporary file in the
system temp directory that is deleted as soon as it has been read. Disconnecting the account removes
the whole cache, including this data. Nothing is sent anywhere else.

Settings control whether the report is imported at all, which export is used, and how many months
are kept (1, 3, 6 or 12, including the current one). Older months are deleted from the local store.

## Limits

- **Top resources are kept individually, the long tail is summed.** Within each account, service
  product, usage type and region, the resources behind 99.5% of the cost are kept, up to 5,000
  resources per month overall. The rest appears as `(other resources)`, so totals still add up.
- **Tags are not imported.** Resource-level questions that involve a cost allocation tag (and
  purchase type, instance type or record type) keep using Cost Explorer and its 14 days.
- **Daily at best.** Hourly exports are summed to days.
- **Credits and refunds are left out**, as everywhere else in CloudPennies. Tax is shown under the
  service "Tax", like in Cost Explorer.
- **Cost basis.** Months are stored in the cost basis selected in Settings (unblended, net unblended,
  amortized, net amortized). Changing it re-imports the months on the next scan. Amortized costs
  follow the amortization rule AWS publishes for the report (Savings Plans and reservation fees
  spread over the usage they cover).
- **Small differences from Cost Explorer are normal**: the two are refreshed at different times,
  and service names are matched from product codes and usage types.
- A few lines of a bill carry a usage date outside the billing month; they are booked on the first
  or last day of that month.
- If the bucket is laid out differently from what AWS documents, CloudPennies says where it looked
  and what it found there. Please report that message.
