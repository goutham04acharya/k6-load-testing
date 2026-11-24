# Step Functions workflow: Prepare -> run all machines in parallel (Map) -> Merge; any error -> MarkFailed.

locals {
  state_machine_name = "${var.name_prefix}-run-workflow"
  lambda_retry = {
    ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
    IntervalSeconds = 2
    MaxAttempts     = 3
    BackoffRate     = 2
  }
  catch_to_mark_failed = { ErrorEquals = ["States.ALL"], ResultPath = "$.error", Next = "MarkFailed" }
}

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "sfn" {
  name               = "${var.name_prefix}-workflow-role"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
}

data "aws_iam_policy_document" "sfn" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [aws_lambda_function.fn["prepare"].arn, aws_lambda_function.fn["merge"].arn]
  }
  statement {
    actions   = ["ecs:RunTask"]
    resources = [for f in values(var.task_definition_families) : "arn:aws:ecs:${var.region}:${var.account_id}:task-definition/${f}:*"]
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
  statement {
    actions   = ["iam:PassRole"]
    resources = [var.runner_execution_role_arn, var.runner_task_role_arn]
  }
  # runTask.sync uses a Step Functions-managed EventBridge rule to learn when tasks stop.
  statement {
    actions   = ["events:PutTargets", "events:PutRule", "events:DescribeRule"]
    resources = ["arn:aws:events:${var.region}:${var.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"]
  }
}

resource "aws_iam_role_policy" "sfn" {
  name   = "${var.name_prefix}-workflow-access"
  role   = aws_iam_role.sfn.id
  policy = data.aws_iam_policy_document.sfn.json
}

resource "aws_sfn_state_machine" "run" {
  name     = local.state_machine_name
  role_arn = aws_iam_role.sfn.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment = "Load Testing k6: prepare a run, start N machines in parallel, wait for all, merge results"
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
        Next           = "RunAllMachines"
      }
      RunAllMachines = {
        Type           = "Map"
        ItemsPath      = "$.plan.runners"
        MaxConcurrency = 0
        ItemProcessor = {
          ProcessorConfig = { Mode = "INLINE" }
          StartAt         = "RunMachine"
          States = {
            RunMachine = {
              Type     = "Task"
              Resource = "arn:aws:states:::ecs:runTask.sync"
              Parameters = {
                Cluster                  = var.cluster_arn
                "TaskDefinition.$"       = "$.taskDef"
                CapacityProviderStrategy = [{ "CapacityProvider.$" = "$.capacityProvider", Weight = 1 }]
                NetworkConfiguration = {
                  AwsvpcConfiguration = {
                    Subnets        = var.subnet_ids
                    SecurityGroups = [var.runner_security_group_id]
                    AssignPublicIp = "ENABLED"
                  }
                }
                Overrides = {
                  ContainerOverrides = [{ Name = "runner", "Environment.$" = "$.env" }]
                }
              }
              TimeoutSecondsPath = "$.timeoutSeconds"
              ResultPath         = null
              # Retry only start-up/capacity errors; never re-run a machine that already ran.
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
      Failed = { Type = "Fail", Error = "RunFailed", Cause = "See the run's error in the web app or: loadtest status <run-id>" }
    }
  })

  depends_on = [aws_iam_role_policy.sfn]
}
