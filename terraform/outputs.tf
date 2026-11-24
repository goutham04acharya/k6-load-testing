output "web_url" {
  value = module.frontend.web_url
}

output "api_url" {
  value = module.backend.api_url
}

output "web_bucket" {
  value = module.frontend.web_bucket_name
}

output "web_distribution_id" {
  value = module.frontend.distribution_id
}

output "runs_bucket" {
  value = module.storage.runs_bucket_name
}

output "table_name" {
  value = module.storage.table_name
}

output "ecr_repository_url" {
  value = module.storage.ecr_repository_url
}

output "cluster_name" {
  value = module.runner.cluster_name
}

output "state_machine_arn" {
  value = module.backend.state_machine_arn
}

output "secrets_path_prefix" {
  value = local.secrets_path_prefix
}

output "region" {
  value = var.region
}

output "terraform_state_bucket" {
  value = module.terraform_state.bucket_name
}
