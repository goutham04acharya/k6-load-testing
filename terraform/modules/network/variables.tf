variable "name_prefix" {
  description = "Prefix for resource names, e.g. load-testing-k6-prod"
  type        = string
}

variable "vpc_cidr" {
  type = string
}

variable "az_count" {
  type    = number
  default = 2
}
