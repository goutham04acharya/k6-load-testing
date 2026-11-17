data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

locals {
  lambda_retry = {
    ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
    IntervalSeconds = 2
    MaxAttempts     = 3
    BackoffRate     = 2
  }
  catch_to_mark_failed = { ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "MarkFailed" }
}

resource "aws_iam_role" "sfn" {
  name               = "${local.name}-workflow"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "sfn" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.fn["prepare"].arn, aws_lambda_function.fn["merge"].arn]
  }
  statement {
    actions = ["ecs:RunTask"]
    resources = [
      for td in aws_ecs_task_definition.runner :
      "arn:aws:ecs:${var.region}:${local.account_id}:task-definition/${td.family}:*"
    ]
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
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.runner_execution.arn, aws_iam_role.runner_task.arn]
  }
  # runTask.sync uses a Step Functions-managed EventBridge rule to learn when tasks stop.
  statement {
    actions   = ["events:PutTargets", "events:PutRule", "events:DescribeRule"]
    resources = ["arn:aws:events:${var.region}:${local.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"]
  }
}

resource "aws_iam_role_policy" "sfn" {
  name   = "workflow"
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn.json
}

resource "aws_sfn_state_machine" "run" {
  name     = "${local.name}-run"
  role_arn = aws_iam_role.sfn.arn
  type     = "STANDARD"

  # Prepare -> run all runners in parallel (Map) -> Merge; any error -> MarkFailed.
  definition = jsonencode({
    Comment = "K6-KT: prepare a run, start N k6 runners in parallel, wait for all, merge results"
    StartAt = "Prepare"
    States = {
      Prepare = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.fn["prepare"].arn
          Payload      = { "runId.$" = "$.runId" }
        }
        ResultSelector = { "runners.$" = "$.Payload.runners" }
        ResultPath     = "$.plan"
        Retry          = [local.lambda_retry]
        Catch          = [local.catch_to_mark_failed]
        Next           = "RunAllRunners"
      }
      RunAllRunners = {
        Type           = "Map"
        ItemsPath      = "$.plan.runners"
        MaxConcurrency = 0
        ItemProcessor = {
          ProcessorConfig = { Mode = "INLINE" }
          StartAt         = "RunRunner"
          States = {
            RunRunner = {
              Type     = "Task"
              Resource = "arn:aws:states:::ecs:runTask.sync"
              Parameters = {
                Cluster                  = aws_ecs_cluster.main.arn
                "TaskDefinition.$"       = "$.taskDef"
                CapacityProviderStrategy = [{ "CapacityProvider.$" = "$.capacityProvider", Weight = 1 }]
                NetworkConfiguration = {
                  AwsvpcConfiguration = {
                    Subnets        = aws_subnet.public[*].id
                    SecurityGroups = [aws_security_group.runner.id]
                    AssignPublicIp = "ENABLED"
                  }
                }
                Overrides = {
                  ContainerOverrides = [{ Name = "runner", "Environment.$" = "$.env" }]
                }
              }
              TimeoutSecondsPath = "$.timeoutSeconds"
              ResultPath         = null
              # Retry only start-up/capacity errors; never re-run a runner that already ran.
              Retry = [{
                ErrorEquals     = ["ECS.AmazonECSException", "ECS.ThrottlingException", "ECS.ServerException"]
                IntervalSeconds = 10
                MaxAttempts     = 3
                BackoffRate     = 2
              }]
              End = true
            }
          }
        }
        ResultPath = null
        Catch      = [local.catch_to_mark_failed]
        Next       = "Merge"
      }
      Merge = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.fn["merge"].arn
          Payload      = { action = "merge", "runId.$" = "$.runId" }
        }
        ResultSelector = { "status.$" = "$.Payload.status" }
        ResultPath     = "$.result"
        Retry          = [local.lambda_retry]
        Catch          = [local.catch_to_mark_failed]
        End            = true
      }
      MarkFailed = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke"
        Parameters = {
          FunctionName = aws_lambda_function.fn["merge"].arn
          Payload      = { action = "fail", "runId.$" = "$.runId", "error.$" = "$.error" }
        }
        Retry = [{ ErrorEquals = ["States.ALL"], IntervalSeconds = 2, MaxAttempts = 3, BackoffRate = 2 }]
        Next  = "Failed"
      }
      Failed = { Type = "Fail", Error = "RunFailed", Cause = "See the run's error with: k6kt status <run-id>" }
    }
  })

  depends_on = [aws_iam_role_policy.sfn]
}
