# Run data: S3 bucket (scripts, progress, summaries, reports), DynamoDB table (projects,
# hashed tokens, runs) and the ECR repository for the runner image.

# ---------- S3 ----------
resource "aws_s3_bucket" "runs" {
  bucket        = "${var.name_prefix}-runs"
  force_destroy = true
}

resource "aws_s3_bucket_ownership_controls" "runs" {
  bucket = aws_s3_bucket.runs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "runs" {
  bucket                  = aws_s3_bucket.runs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "runs" {
  bucket = aws_s3_bucket.runs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "runs" {
  bucket = aws_s3_bucket.runs.id
  rule {
    id     = "expire-run-files"
    status = "Enabled"
    filter {
      prefix = "runs/"
    }
    expiration {
      days = var.run_files_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# The web app uploads test scripts straight to S3 with presigned PUT links.
resource "aws_s3_bucket_cors_configuration" "runs" {
  bucket = aws_s3_bucket.runs.id
  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = var.cors_origins
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }
}

data "aws_iam_policy_document" "runs" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.runs.arn, "${aws_s3_bucket.runs.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "runs" {
  bucket     = aws_s3_bucket.runs.id
  policy     = data.aws_iam_policy_document.runs.json
  depends_on = [aws_s3_bucket_public_access_block.runs]
}

# ---------- DynamoDB ----------
resource "aws_dynamodb_table" "main" {
  name         = "${var.name_prefix}-main"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "gsi1pk"
    type = "S"
  }
  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "byProject"
    projection_type = "ALL"
    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }
}

# ---------- ECR ----------
resource "aws_ecr_repository" "runner" {
  name                 = "${var.name_prefix}-runner"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "runner" {
  repository = aws_ecr_repository.runner.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 5 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 5 }
      action       = { type = "expire" }
    }]
  })
}
