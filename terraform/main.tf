# Load Testing k6: all AWS resources. Every name is <app_slug>-<component>, e.g. load-testing-k6-runs.

data "aws_caller_identity" "current" {}

locals {
  name_prefix         = var.app_slug
  secrets_path_prefix = "/${var.app_slug}/"
  web_origins         = concat([module.frontend.web_url], var.dev_origins)
}

module "terraform_state" {
  source      = "./modules/terraform-state"
  bucket_name = "${var.app_slug}-terraform-state"
}

module "network" {
  source      = "./modules/network"
  name_prefix = local.name_prefix
  vpc_cidr    = var.vpc_cidr
}

module "frontend" {
  source      = "./modules/frontend"
  name_prefix = local.name_prefix
}

module "storage" {
  source                   = "./modules/storage"
  name_prefix              = local.name_prefix
  run_files_retention_days = var.run_files_retention_days
  cors_origins             = local.web_origins
}

module "runner" {
  source             = "./modules/runner"
  name_prefix        = local.name_prefix
  region             = var.region
  ecr_repository_url = module.storage.ecr_repository_url
  runs_bucket_name   = module.storage.runs_bucket_name
  runs_bucket_arn    = module.storage.runs_bucket_arn
  log_retention_days = var.log_retention_days
  runner_sizes       = var.runner_sizes
}

module "backend" {
  source                    = "./modules/backend"
  name_prefix               = local.name_prefix
  region                    = var.region
  account_id                = data.aws_caller_identity.current.account_id
  lambda_source_dir         = "${path.root}/../backend/dist/lambda"
  table_name                = module.storage.table_name
  table_arn                 = module.storage.table_arn
  runs_bucket_name          = module.storage.runs_bucket_name
  runs_bucket_arn           = module.storage.runs_bucket_arn
  cluster_name              = module.runner.cluster_name
  cluster_arn               = module.runner.cluster_arn
  task_definition_families  = module.runner.task_definition_families
  runner_execution_role_arn = module.runner.execution_role_arn
  runner_task_role_arn      = module.runner.task_role_arn
  subnet_ids                = module.network.public_subnet_ids
  runner_security_group_id  = module.network.runner_security_group_id
  secrets_path_prefix       = local.secrets_path_prefix
  cors_origins              = local.web_origins
  log_retention_days        = var.log_retention_days
}
