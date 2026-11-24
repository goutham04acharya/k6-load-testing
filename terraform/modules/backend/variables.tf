variable "name_prefix" {
  type = string
}

variable "region" {
  type = string
}

variable "account_id" {
  type = string
}

variable "lambda_source_dir" {
  description = "Built Lambda code (backend/dist/lambda)"
  type        = string
}

variable "table_name" {
  type = string
}

variable "table_arn" {
  type = string
}

variable "runs_bucket_name" {
  type = string
}

variable "runs_bucket_arn" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "task_definition_families" {
  type = map(string)
}

variable "runner_execution_role_arn" {
  type = string
}

variable "runner_task_role_arn" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "runner_security_group_id" {
  type = string
}

variable "secrets_path_prefix" {
  description = "SSM Parameter Store path for project secrets, ending in /"
  type        = string
}

variable "cors_origins" {
  type = list(string)
}

variable "log_retention_days" {
  type = number
}
