resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_cloudwatch_log_group" "runner" {
  name              = "/${local.name}/runner"
  retention_in_days = var.log_retention_days
}

# ---------- Roles ----------
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
resource "aws_iam_role" "runner_execution" {
  name               = "${local.name}-runner-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "runner_execution" {
  role       = aws_iam_role.runner_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Used by the runner's start script only: read its test files, write its results.
# k6 scripts cannot reach these credentials: --blacklist-ip blocks 169.254.0.0/16.
resource "aws_iam_role" "runner_task" {
  name               = "${local.name}-runner-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "runner_task" {
  statement {
    sid     = "ReadTestFiles"
    actions = ["s3:GetObject"]
    resources = [
      "${aws_s3_bucket.runs.arn}/runs/*/archive.tar",
      "${aws_s3_bucket.runs.arn}/runs/*/env.json",
    ]
  }
  statement {
    sid       = "WriteRunnerResults"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.runs.arn}/runs/*/runner-*/*"]
  }
}

resource "aws_iam_role_policy" "runner_task" {
  name   = "runner-s3"
  role   = aws_iam_role.runner_task.id
  policy = data.aws_iam_policy_document.runner_task.json
}

# ---------- Task definitions: one per runner size ----------
resource "aws_ecs_task_definition" "runner" {
  for_each = var.runner_sizes

  family                   = "${local.name}-runner-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  execution_role_arn       = aws_iam_role.runner_execution.arn
  task_role_arn            = aws_iam_role.runner_task.arn

  # x86_64 so Fargate Spot is available (Spot does not support ARM64).
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name        = "runner"
    image       = "${aws_ecr_repository.runner.repository_url}:latest"
    essential   = true
    stopTimeout = 120
    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "AWS_DEFAULT_REGION", value = var.region },
      { name = "BUCKET", value = aws_s3_bucket.runs.bucket },
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
