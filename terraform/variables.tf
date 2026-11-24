variable "app_name" {
  description = "Display name of the application"
  type        = string
  default     = "Load Testing k6"
}

variable "app_slug" {
  description = "Lowercase name that starts every resource name"
  type        = string
  default     = "load-testing-k6"
}

variable "region" {
  type    = string
  default = "ap-south-1"
}

variable "aws_profile" {
  type    = string
  default = "goutham-iam"
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

variable "runner_sizes" {
  description = "Load machine sizes (users per size are set in backend/src/functions/prepare)"
  type        = map(object({ cpu = number, memory = number }))
  default = {
    small  = { cpu = 512, memory = 1024 }  # up to 100 users
    medium = { cpu = 1024, memory = 2048 } # 101-250 users
    large  = { cpu = 2048, memory = 4096 } # 251-500 users per machine
  }
}

variable "dev_origins" {
  description = "Extra browser origins allowed to call the API (local development of the web app)"
  type        = list(string)
  default     = ["http://localhost:5173"]
}
