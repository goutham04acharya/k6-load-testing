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
    bucket       = "load-testing-k6-terraform-state"
    key          = "load-testing-k6.tfstate"
    region       = "ap-south-1"
    profile      = "goutham-iam"
    encrypt      = true
    use_lockfile = true
  }
}
