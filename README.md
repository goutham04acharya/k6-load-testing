# K6-KT — self-hosted k6 load testing on AWS

Testers write a normal k6 script, run one command, and the test runs on AWS Fargate (one or many machines).
Results are saved centrally with an HTML report. No servers run when nobody is testing (idle cost < $1/month).

```
k6kt CLI ──► API Gateway ──► API Lambda ──► DynamoDB (projects, tokens, runs)
                                 │
                                 ▼
                      Step Functions workflow
           Prepare ──► N × Fargate runners (k6) ──► Merge
                              │
                              ▼
                     S3 (script, progress, summary, report.html)
```

AWS account `072707626196`, region `ap-south-1`, profile `goutham-iam`.

## Repository layout

| Path | What it is |
|---|---|
| `terraform/` | All AWS infrastructure, one file per area (`network.tf`, `s3.tf`, `dynamodb.tf`, `ecr.tf`, `ecs.tf`, `lambda.tf`, `step-functions.tf`, `api-gateway.tf`). State is in S3. |
| `terraform/bootstrap/` | Creates the S3 bucket that holds Terraform state. Applied once; a bucket cannot store the state that creates it, so this is separate. |
| `lambda/` | Code for the 3 Lambda functions: `api` (HTTP API + report pages/PDF), `prepare` (plans runners), `merge` (combines results). |
| `runner/` | Docker image each Fargate runner uses: k6 + a start script. |
| `cli/k6kt.mjs` | The command testers use. No dependencies, Node 18+. |
| `scripts/` | Admin helpers: build the runner image, create projects/tokens, store secrets, install k6. |
| `examples/` | Example tests. |

## For testers: running tests

One-time setup:

```bash
./scripts/install-k6.sh                       # installs k6 into ~/.local/bin (or install k6 any other way)
node cli/k6kt.mjs login --api <api-url> --token <your-token>   # an admin gives you both
```

Tip: `alias k6kt="node $PWD/cli/k6kt.mjs"` so you can type `k6kt ...`.

| Command | What it does |
|---|---|
| `k6kt run test.js --local` | Runs on your laptop with a live dashboard (http://127.0.0.1:5665), then saves results centrally |
| `k6kt run test.js --cloud` | Runs on AWS and prints progress every 10 s, then the result and report link |
| `k6kt run test.js --cloud -e BASE_URL=https://staging.example.com` | Passes values to `__ENV` in the script |
| `k6kt run test.js --cloud --runners 4` | Splits the test across 4 machines (done automatically above 500 VUs) |
| `k6kt run test.js --cloud --spot` | Uses Fargate Spot: ~70% cheaper, AWS may interrupt it. Avoid for release tests |
| `k6kt list` | Recent runs with p95, error rate and status |
| `k6kt status <run-id>` | One run in detail |
| `k6kt open [run-id]` | Opens the run's report page in your browser (newest run if no id) |
| `k6kt link [run-id]` | Prints the run's permanent share link (newest run if no id) |
| `k6kt run test.js --cloud --open` | Opens the report page automatically when the run ends |
| `k6kt stop <run-id>` | Stops a run (Ctrl+C during `run --cloud` does the same) |

`k6kt run` exits 0 when the run passed and 1 when it failed, so it can gate a CI pipeline:

```yaml
# GitHub Actions example
- run: node cli/k6kt.mjs run tests/checkout.js --cloud
  env:
    K6KT_API: ${{ secrets.K6KT_API }}
    K6KT_TOKEN: ${{ secrets.K6KT_TOKEN }}
```

### Reports

Every run gets a **permanent link** (printed at the end of `k6kt run`, or `k6kt link <run-id>`).
Anyone with the link can open it, with no login needed. The key in the link is random, so links can't be guessed.

The report page shows pass/fail, the key numbers, thresholds, checks, a response-time breakdown and, for split tests, each runner.
Below that is the full interactive k6 report with charts. Buttons at the top:

- **Download PDF**: a printable summary. It is built the first time someone clicks it and saved to S3 (`runs/<id>/report.pdf`).
- **Download HTML report**: the full interactive k6 report as one file that opens offline in any browser.

The "Report" button *inside* the k6 report is k6's own "save this page" button; you don't need it.

### Writing tests

Normal k6 scripts work unchanged, including imports of other local files (they are bundled with `k6 archive`).
Use `thresholds` to decide pass/fail, for example `http_req_duration: ['p(95)<500']`.

Notes:
- k6 skips the HTML report for runs shorter than about 30 seconds. The numbers are still saved.
- On AWS, scripts cannot call private IP ranges, localhost or the AWS metadata endpoints (blocked on purpose).
- With several runners, `setup()` runs once **per runner**.
- With several runners, p90/p95/p99/max show the worst runner (a safe upper bound); counts and rates are exact.

## For admins

All scripts use profile `goutham-iam` and region `ap-south-1` (override with `AWS_PROFILE` / `AWS_REGION`).

```bash
./scripts/create-project.sh shop-app 1000 60 2 15 5000   # name, maxVUs, maxMinutes, runs at once, maxRunners, VU-hours/month
./scripts/create-token.sh shop-app alice-laptop          # prints the token once (only its hash is stored)
./scripts/set-secret.sh shop-app TEST_PASS               # prompts for the value; script reads __ENV.TEST_PASS on AWS runs
```

Revoke a token: set `revoked = true` on its `TOKEN#<sha256>` item in the `k6kt` DynamoDB table.

### Runner sizes

| VUs per runner | Fargate size |
|---|---|
| up to 100 | 0.5 vCPU / 1 GB |
| 101–250 | 1 vCPU / 2 GB |
| 251–500 | 2 vCPU / 4 GB |
| more than 500 VUs total | ceil(VUs ÷ 500) runners of 2 vCPU / 4 GB |

The account's Fargate quota is **30 vCPU** (both on-demand and Spot) = 15 large runners ≈ 7,500 VUs.
Request an increase in Service Quotas before running bigger tests.

## Deploying changes

```bash
# 1. Lambda dependencies (needed before plan/apply, because Terraform zips lambda/)
(cd lambda && npm ci --omit=dev && npm test)

# 2. Infrastructure + Lambda code
cd terraform
terraform init          # first time only; state lives in s3://k6kt-tfstate-072707626196
terraform plan -out=tfplan
terraform apply tfplan
cd ..

# 3. Runner image (only when runner/ changes)
./scripts/build-runner.sh
```

First-time setup from an empty account: `cd terraform/bootstrap && terraform init && terraform apply` creates the state bucket, then run the steps above.

## Cost

About $2–3/month at 500 tests × 20 VUs × 5 min. You pay for runner minutes, public IPs while runners run, and outbound traffic above 100 GB/month.
Nothing runs between tests. Logs are kept 14 days, and run files are deleted after 180 days.

## Tearing it down

```bash
cd terraform && terraform destroy
```

This deletes everything, including saved runs. The state bucket in `terraform/bootstrap` stays until you destroy it separately.
