# The three Lambda functions, built by `npm run build` in backend/ (dist/lambda).

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = var.lambda_source_dir
  output_path = "${path.root}/.build/${var.name_prefix}-lambda.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

locals {
  functions = {
    api     = { handler = "api.handler", timeout = 20, memory = 512, description = "HTTP API and report pages" }
    prepare = { handler = "prepare.handler", timeout = 30, memory = 256, description = "Plans machines for a run" }
    merge   = { handler = "merge.handler", timeout = 60, memory = 256, description = "Combines machine results" }
  }
  table_arns = [var.table_arn, "${var.table_arn}/index/*"]
}

resource "aws_iam_role" "fn" {
  for_each           = local.functions
  name               = "${var.name_prefix}-${each.key}-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "fn_logs" {
  for_each   = local.functions
  role       = aws_iam_role.fn[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.name_prefix}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "fn" {
  for_each         = local.functions
  function_name    = "${var.name_prefix}-${each.key}"
  description      = each.value.description
  role             = aws_iam_role.fn[each.key].arn
  handler          = each.value.handler
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = each.value.memory
  timeout          = each.value.timeout
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      NODE_OPTIONS        = "--enable-source-maps"
      TABLE               = var.table_name
      BUCKET              = var.runs_bucket_name
      CLUSTER             = var.cluster_name
      STATE_MACHINE_ARN   = "arn:aws:states:${var.region}:${var.account_id}:stateMachine:${local.state_machine_name}"
      TASK_DEF_SMALL      = var.task_definition_families["small"]
      TASK_DEF_MEDIUM     = var.task_definition_families["medium"]
      TASK_DEF_LARGE      = var.task_definition_families["large"]
      SECRETS_PATH_PREFIX = var.secrets_path_prefix
    }
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.fn_logs]
}

# ---------- permissions ----------
data "aws_iam_policy_document" "api" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = local.table_arns
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.runs_bucket_arn}/runs/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [var.runs_bucket_arn]
  }
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.run.arn]
  }
  statement {
    actions   = ["states:StopExecution", "states:DescribeExecution"]
    resources = ["arn:aws:states:${var.region}:${var.account_id}:execution:${local.state_machine_name}:*"]
  }
  statement {
    actions   = ["ecs:ListTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }
  statement {
    actions   = ["ecs:StopTask", "ecs:DescribeTasks"]
    resources = ["arn:aws:ecs:${var.region}:${var.account_id}:task/${var.cluster_name}/*"]
  }
}

data "aws_iam_policy_document" "prepare" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = local.table_arns
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${var.runs_bucket_arn}/runs/*/env.json"]
  }
  statement {
    actions   = ["ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${var.region}:${var.account_id}:parameter${trimsuffix(var.secrets_path_prefix, "/")}/*"]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "merge" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = local.table_arns
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${var.runs_bucket_arn}/runs/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [var.runs_bucket_arn]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "${var.name_prefix}-api-access"
  role   = aws_iam_role.fn["api"].id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_iam_role_policy" "prepare" {
  name   = "${var.name_prefix}-prepare-access"
  role   = aws_iam_role.fn["prepare"].id
  policy = data.aws_iam_policy_document.prepare.json
}

resource "aws_iam_role_policy" "merge" {
  name   = "${var.name_prefix}-merge-access"
  role   = aws_iam_role.fn["merge"].id
  policy = data.aws_iam_policy_document.merge.json
}
