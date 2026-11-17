# S3 bucket for run files: scripts, progress, summaries, HTML reports.

resource "aws_s3_bucket" "runs" {
  bucket        = local.bucket
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

data "aws_iam_policy_document" "runs_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.runs.arn,
      "${aws_s3_bucket.runs.arn}/*",
    ]
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
  policy     = data.aws_iam_policy_document.runs_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.runs]
}
