output "api_url" {
  value = aws_apigatewayv2_api.main.api_endpoint
}

output "runs_bucket" {
  value = aws_s3_bucket.runs.bucket
}

output "table_name" {
  value = aws_dynamodb_table.main.name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.runner.repository_url
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.run.arn
}

output "region" {
  value = var.region
}
