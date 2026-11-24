# Load Testing k6

Run [k6](https://grafana.com/docs/k6/) load tests on AWS from a web page or the command line.
Pick the APIs to call, choose how many users, press **Run**: machines start on AWS Fargate, split the load,
stream live numbers, and every result is saved with a shareable report and PDF.
Nothing runs between tests, so the idle cost is under $1/month.

```
 Web app (React)  ─┐
                   ├─► API Gateway ─► api Lambda ─► DynamoDB (projects, tokens, runs)
 loadtest CLI    ──┘          │
                              ▼
                   Step Functions workflow
        prepare Lambda ─► N × Fargate machines running k6 ─► merge Lambda
                              │
                              ▼
               S3 (scripts, live progress, summaries, HTML/PDF reports)
```

AWS account `072707626196`, region `ap-south-1` (Mumbai), profile `goutham-iam`.

## Repository layout

```
backend/                 TypeScript: Lambdas, CLI, load machine image, admin scripts
  src/functions/api/       HTTP API + public report pages (handler.ts, runs.ts, share.ts)
  src/functions/prepare/   plans machines and splits the load
  src/functions/merge/     combines machine results, decides pass/fail
  src/lib/                 shared types, storage, result merging, report page + PDF
  src/cli/loadtest.ts      the `loadtest` command
  runner/                  Docker image each load machine runs (k6 + start script)
  scripts/                 create projects/tokens, store secrets, push the runner image
  examples/                example k6 scripts
  test/                    unit tests
frontend/                TypeScript + React (Vite): the web app
  src/pages/               Runs, New test, Run detail, Compare, Settings, Sign in
  scripts/deploy.sh        build and upload to S3 + CloudFront
terraform/               all AWS resources
  main.tf                  the whole system: calls the modules below
  variables.tf / outputs.tf / providers.tf / versions.tf / terraform.tfvars
  modules/terraform-state  S3 bucket holding Terraform state
  modules/network          VPC, public subnets, security group (no NAT Gateway)
  modules/storage          S3 runs bucket, DynamoDB table, ECR repository
  modules/runner           ECS cluster, machine sizes (task definitions), roles
  modules/backend          Lambdas, Step Functions workflow, HTTP API
  modules/frontend         S3 web bucket + CloudFront
```

### Naming

Every AWS resource is named `load-testing-k6-<component>` and tagged
`Application=Load Testing k6`, `Project=load-testing-k6`, `ManagedBy=terraform`.

| Resource | Name |
|---|---|
| Terraform state bucket | `load-testing-k6-terraform-state` |
| Runs bucket / web bucket | `load-testing-k6-runs` / `load-testing-k6-web` |
| DynamoDB table | `load-testing-k6-main` |
| Lambdas | `load-testing-k6-api`, `-prepare`, `-merge` |
| Workflow | `load-testing-k6-run-workflow` |
| API | `load-testing-k6-api` |
| ECS cluster / ECR | `load-testing-k6-cluster` / `load-testing-k6-runner` |
| Machine sizes | `load-testing-k6-runner-small`, `-medium`, `-large` |
| VPC / security group | `load-testing-k6-vpc` / `load-testing-k6-runner-sg` |
| Secrets (SSM) | `/load-testing-k6/<project>/<NAME>` |

## Using the web app

Sign in with your API token, then **New test**:

1. **APIs to call**: method, URL, headers, body, expected status. Add more calls, or **Import from cURL**
   (paste "Copy as cURL" from browser dev tools or Postman). Use `{{NAME}}` for values from step 4 or project secrets.
2. **Load**: start from a template (Smoke, Load, Stress, Spike, Soak) or pick a shape: ramp up & down,
   steady users, requests per second, or spike. A chart previews the shape.
3. **Pass rules**: p95 response time, error rate, status checks.
4. **Environment values**, 5. **Machines** (count, Spot), then **Run test**.

The run page shows the phases, a progress bar and live charts (users, requests/s, p95, errors) every 10 s,
with a **Stop** button. When it finishes: results, a **Per API** table, the full report, **Download PDF**,
**Copy share link** and **Run again**. **Compare** shows two runs side by side with ▲/▼ changes.
Or use **Write or upload script** to run any single-file k6 script.

## Using the CLI

```bash
cd backend && npm install && npm run build && npm link     # installs the `loadtest` command
./scripts/install-k6.sh                                    # k6 for local runs (~/.local/bin)
loadtest login --api <api-url> --token <token>

loadtest run test.js --local          # on your laptop, live dashboard, results saved centrally
loadtest run test.js --cloud --open   # on AWS, opens the report when done
loadtest list | status <id> | open [id] | link [id] | stop <id>
```

`loadtest run` exits 0 when the run passed and 1 when it failed, so it can gate CI
(`LOADTEST_API` / `LOADTEST_TOKEN` environment variables replace `login`).

## Admin

```bash
cd backend
./scripts/create-project.sh shop-app 1000 60 2 15 5000   # name, max users, max minutes, runs at once, max machines, VU-hours/month
./scripts/create-token.sh shop-app alice-laptop          # prints the token once (only its hash is stored)
./scripts/revoke-token.sh <token>
./scripts/set-secret.sh shop-app TEST_PASS               # prompts for the value
```

Machine sizes: up to 100 users → 0.5 vCPU / 1 GB; 101–250 → 1 vCPU / 2 GB; 251–500 → 2 vCPU / 4 GB;
more → ceil(users ÷ 500) machines of 2 vCPU / 4 GB. The account's Fargate quota is 30 vCPU (≈ 7,500 users);
request more in Service Quotas for bigger tests.

## Deploying

```bash
# 1. Backend code (Terraform zips backend/dist/lambda)
cd backend && npm ci && npm run check && cd ..

# 2. Infrastructure
cd terraform && terraform init && terraform plan -out=tfplan && terraform apply tfplan && cd ..

# 3. Load machine image (only when backend/runner changes)
backend/scripts/build-runner.sh

# 4. Web app
frontend/scripts/deploy.sh
```

Terraform state lives in `s3://load-testing-k6-terraform-state` (created by `modules/terraform-state`, protected
from deletion). On a brand-new account, comment out the `backend "s3"` block in `versions.tf` for the first
`terraform apply`, then restore it and run `terraform init -migrate-state`.

Run the web app locally against the deployed API:

```bash
cd frontend
echo "VITE_API_URL=$(terraform -chdir=../terraform output -raw api_url)" > .env.local
npm install && npm run dev        # http://localhost:5173
```

## Cost

About $2–3/month at 500 tests × 20 users × 5 min. You pay for machine minutes, their public IPs while
running, and outbound traffic above 100 GB/month. Logs are kept 14 days; run files 180 days.

## Tearing down

```bash
cd terraform && terraform destroy
```

The state bucket is protected (`prevent_destroy`), so it stays unless you remove that line first.
