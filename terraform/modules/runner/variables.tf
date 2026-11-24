variable "name_prefix" {
  type = string
}

variable "region" {
  type = string
}

variable "ecr_repository_url" {
  type = string
}

variable "runs_bucket_name" {
  type = string
}

variable "runs_bucket_arn" {
  type = string
}

variable "log_retention_days" {
  type = number
}

variable "runner_sizes" {
  description = "Machine sizes; users per size are set in backend/src/functions/prepare"
  type        = map(object({ cpu = number, memory = number }))
}
