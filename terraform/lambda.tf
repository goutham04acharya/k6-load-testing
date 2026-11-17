# All three functions share one package built from ../lambda
# (run `npm ci --omit=dev` in lambda/ before terraform plan/apply).

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda"
  output_path = "${path.module}/.build/lambda.zip"
  excludes    = ["package-lock.json", "test"]
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
    api = {
      handler = "src/api.handler"
      timeout = 15
    }
    prepare = {
      handler = "src/prepare.handler"
      timeout = 30
    }
    merge = {
      handler = "src/merge.handler"
      timeout = 60
    }
  }

  task_definition_families = { for k, v in aws_ecs_task_definition.runner : k => v.family }
}

resource "aws_iam_role" "fn" {
  for_each           = local.functions
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "fn_logs" {
  for_each   = local.functions
  role       = aws_iam_role.fn[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "fn" {
  for_each          = local.functions
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "fn" {
  for_each         = local.functions
  function_name    = "${local.name}-${each.key}"
  role             = aws_iam_role.fn[each.key].arn
  handler          = each.value.handler
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = each.value.timeout
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      TABLE               = aws_dynamodb_table.main.name
      BUCKET              = aws_s3_bucket.runs.bucket
      CLUSTER             = aws_ecs_cluster.main.name
      STATE_MACHINE_ARN   = "arn:aws:states:${var.region}:${local.account_id}:stateMachine:${local.name}-run"
      TASK_DEF_SMALL      = local.task_definition_families["small"]
      TASK_DEF_MEDIUM     = local.task_definition_families["medium"]
      TASK_DEF_LARGE      = local.task_definition_families["large"]
      SECRETS_PATH_PREFIX = "/${local.name}/"
    }
  }

  depends_on = [aws_cloudwatch_log_group.fn, aws_iam_role_policy_attachment.fn_logs]
}

# ---------- Permissions ----------
locals {
  table_arns = [aws_dynamodb_table.main.arn, "${aws_dynamodb_table.main.arn}/index/*"]
}

data "aws_iam_policy_document" "api" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = local.table_arns
  }
  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.runs.arn}/runs/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.runs.arn]
  }
  statement {
    actions   = ["states:StartExecution"]
    resources = [aws_sfn_state_machine.run.arn]
  }
  statement {
    actions   = ["states:StopExecution", "states:DescribeExecution"]
    resources = ["arn:aws:states:${var.region}:${local.account_id}:execution:${aws_sfn_state_machine.run.name}:*"]
  }
  statement {
    actions   = ["ecs:ListTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }
  statement {
    actions   = ["ecs:StopTask", "ecs:DescribeTasks"]
    resources = ["arn:aws:ecs:${var.region}:${local.account_id}:task/${aws_ecs_cluster.main.name}/*"]
  }
}

data "aws_iam_policy_document" "prepare" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = local.table_arns
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.runs.arn}/runs/*/env.json"]
  }
  statement {
    actions   = ["ssm:GetParametersByPath"]
    resources = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter/${local.name}/*"]
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
    resources = ["${aws_s3_bucket.runs.arn}/runs/*"]
  }
  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.runs.arn]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.fn["api"].id
  policy = data.aws_iam_policy_document.api.json
}

resource "aws_iam_role_policy" "prepare" {
  name   = "prepare"
  role   = aws_iam_role.fn["prepare"].id
  policy = data.aws_iam_policy_document.prepare.json
}

resource "aws_iam_role_policy" "merge" {
  name   = "merge"
  role   = aws_iam_role.fn["merge"].id
  policy = data.aws_iam_policy_document.merge.json
}
