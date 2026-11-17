variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "aws_profile" {
  type    = string
  default = "goutham-iam"
}

variable "name" {
  description = "Prefix for every resource name"
  type        = string
  default     = "k6kt"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "run_files_retention_days" {
  description = "Delete scripts, summaries and reports after this many days"
  type        = number
  default     = 180
}

# Runner sizes. VUs per runner are starting estimates; adjust after real tests.
variable "runner_sizes" {
  type = map(object({ cpu = number, memory = number }))
  default = {
    small  = { cpu = 512, memory = 1024 }  # up to 100 VUs
    medium = { cpu = 1024, memory = 2048 } # 101-250 VUs
    large  = { cpu = 2048, memory = 4096 } # 251-500 VUs per runner
  }
}
