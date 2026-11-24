variable "name_prefix" {
  type = string
}

variable "run_files_retention_days" {
  description = "Delete scripts, summaries and reports after this many days"
  type        = number
}

variable "cors_origins" {
  description = "Browser origins allowed to upload scripts (the web app)"
  type        = list(string)
}
