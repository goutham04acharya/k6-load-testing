output "runs_bucket_name" {
  value = aws_s3_bucket.runs.bucket
}

output "runs_bucket_arn" {
  value = aws_s3_bucket.runs.arn
}

output "table_name" {
  value = aws_dynamodb_table.main.name
}

output "table_arn" {
  value = aws_dynamodb_table.main.arn
}

output "ecr_repository_url" {
  value = aws_ecr_repository.runner.repository_url
}
