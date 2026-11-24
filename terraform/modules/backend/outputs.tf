output "api_url" {
  value = aws_apigatewayv2_api.this.api_endpoint
}

output "state_machine_arn" {
  value = aws_sfn_state_machine.run.arn
}

output "function_names" {
  value = { for k, f in aws_lambda_function.fn : k => f.function_name }
}
