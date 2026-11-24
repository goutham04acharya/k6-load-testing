# ECS cluster and task definitions for the load machines (one per size), plus their roles.

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/${var.name_prefix}/runner"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Used by ECS itself: pull the image, write logs.
resource "aws_iam_role" "execution" {
  name               = "${var.name_prefix}-runner-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Used by the machine's start script only: read its test files, write its results.
# k6 scripts cannot reach these credentials: --blacklist-ip blocks 169.254.0.0/16.
resource "aws_iam_role" "task" {
  name               = "${var.name_prefix}-runner-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid     = "ReadTestFiles"
    actions = ["s3:GetObject"]
    resources = [
      "${var.runs_bucket_arn}/runs/*/archive.tar",
      "${var.runs_bucket_arn}/runs/*/script.js",
      "${var.runs_bucket_arn}/runs/*/env.json",
    ]
  }
  statement {
    sid       = "WriteResults"
    actions   = ["s3:PutObject"]
    resources = ["${var.runs_bucket_arn}/runs/*/runner-*/*"]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.name_prefix}-runner-s3"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_ecs_task_definition" "runner" {
  for_each = var.runner_sizes

  family                   = "${var.name_prefix}-runner-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  # x86_64 so Fargate Spot is available (Spot does not support ARM64).
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name        = "runner"
    image       = "${var.ecr_repository_url}:latest"
    essential   = true
    stopTimeout = 120
    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "AWS_DEFAULT_REGION", value = var.region },
      { name = "BUCKET", value = var.runs_bucket_name },
    ]
    ulimits = [{ name = "nofile", softLimit = 65535, hardLimit = 65535 }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.runner.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "runner"
      }
    }
  }])
}
