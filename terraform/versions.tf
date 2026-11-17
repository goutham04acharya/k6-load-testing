terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # State bucket is created by terraform/bootstrap.
  backend "s3" {
    bucket       = "k6kt-tfstate-072707626196"
    key          = "k6kt/main.tfstate"
    region       = "ap-south-1"
    profile      = "goutham-iam"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region  = var.region
  profile = var.aws_profile
  default_tags {
    tags = { Project = "k6kt", ManagedBy = "terraform" }
  }
}

data "aws_caller_identity" "me" {}
data "aws_availability_zones" "azs" {
  state = "available"
}

locals {
  name       = var.name
  account_id = data.aws_caller_identity.me.account_id
  bucket     = "${var.name}-runs-${data.aws_caller_identity.me.account_id}"
}
