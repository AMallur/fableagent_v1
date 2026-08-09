data "aws_availability_zones" "available" {
  state = "available"
}
data "aws_caller_identity" "current" {
 
}

locals {
  name       = "${var.project_name}-${var.environment}"
  azs        = slice(data.aws_availability_zones.available.names, 0, 2)
  alarm_arns = var.alarm_topic_arn == "" ? [] : [var.alarm_topic_arn]
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "AWS_DOCUMENT_BUCKET", value = aws_s3_bucket.documents.id },
    { name = "AWS_DOCUMENT_KMS_KEY_ID", value = aws_kms_key.phi.arn },
    { name = "DB_HOST", value = try(aws_db_instance.postgres[0].address, "") },
    { name = "DB_PORT", value = try(tostring(aws_db_instance.postgres[0].port), "5432") },
    { name = "DB_NAME", value = var.db_name },
    { name = "DB_USER", value = var.runtime_db_user },
    { name = "PGSSLMODE", value = "verify-full" },
  ]
  common_secrets = concat([
    { name = "DB_PASSWORD", valueFrom = "${var.runtime_db_password_secret_arn}:password::" },
    { name = "SESSION_SECRET", valueFrom = "${var.session_secret_arn}:value::" },
    { name = "DATA_ENCRYPTION_KEY", valueFrom = "${var.data_encryption_key_secret_arn}:value::" },
  ], var.smtp_secret_arn == "" ? [] : [
    { name = "SMTP_HOST", valueFrom = "${var.smtp_secret_arn}:host::" },
    { name = "SMTP_PORT", valueFrom = "${var.smtp_secret_arn}:port::" },
    { name = "SMTP_USER", valueFrom = "${var.smtp_secret_arn}:user::" },
    { name = "SMTP_PASS", valueFrom = "${var.smtp_secret_arn}:password::" },
    { name = "SMTP_FROM", valueFrom = "${var.smtp_secret_arn}:from::" },
  ])
}

# Two-AZ VPC. A single NAT gateway keeps a pilot's fixed cost bounded; move to
# one NAT per AZ before an HA SLA that requires independent egress paths.
resource "aws_vpc" "main" {
    cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = local.name
}
}
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}
resource "aws_subnet" "public" {
    count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  map_public_ip_on_launch = false
  tags = { Name = "${local.name}-public-${count.index + 1}"
}
}
resource "aws_subnet" "private" {
    count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
  tags = { Name = "${local.name}-private-${count.index + 1}"
}
}
resource "aws_eip" "nat" {
  count      = var.deploy_paid_infrastructure ? 1 : 0
  domain     = "vpc"
  depends_on = [aws_internet_gateway.main]
}
resource "aws_nat_gateway" "main" {
    count         = var.deploy_paid_infrastructure ? 1 : 0
    allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
}
resource "aws_route" "public" {
    route_table_id = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id = aws_internet_gateway.main.id
}
resource "aws_route_table_association" "public" {
    count = 2
  subnet_id = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
}
# No default route while deploy_paid_infrastructure is false — the private
# subnets stay reachable only via the free S3 gateway endpoint until the NAT
# gateway is deployed (tasks aren't running yet anyway, gated separately by
# services_enabled).
resource "aws_route" "private" {
    count = var.deploy_paid_infrastructure ? 1 : 0
    route_table_id = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id = aws_nat_gateway.main[0].id
}
resource "aws_route_table_association" "private" {
    count = 2
  subnet_id = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}
resource "aws_vpc_endpoint" "s3" {
    vpc_id = aws_vpc.main.id
  service_name = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids = [aws_route_table.private.id]
}

resource "aws_kms_key" "phi" {
    description             = "${local.name} PHI at-rest encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}
resource "aws_kms_alias" "phi" {
  name = "alias/${local.name}-phi"
  target_key_id = aws_kms_key.phi.key_id
}

resource "aws_s3_bucket" "documents" {
    bucket_prefix = "${local.name}-documents-"
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "documents" {
    bucket = aws_s3_bucket.documents.id
  block_public_acls = true
  block_public_policy = true
  ignore_public_acls = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "documents" {
    bucket = aws_s3_bucket.documents.id
  rule {
  object_ownership = "BucketOwnerEnforced"
}
}
resource "aws_s3_bucket_versioning" "documents" {
    bucket = aws_s3_bucket.documents.id
  versioning_configuration {
  status = "Enabled"
}
}
resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
    bucket = aws_s3_bucket.documents.id
  rule {
      bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm = "aws:kms"
      kms_master_key_id = aws_kms_key.phi.arn
   
}
 
}
}
resource "aws_s3_bucket_lifecycle_configuration" "documents" {
    bucket = aws_s3_bucket.documents.id
  rule {
      id = "noncurrent-retention"
  status = "Enabled"
    filter {}
    noncurrent_version_expiration {
  noncurrent_days = 365
}
    abort_incomplete_multipart_upload {
  days_after_initiation = 7
}
 
}
  depends_on = [aws_s3_bucket_versioning.documents]
}
resource "aws_s3_bucket_policy" "documents" {
    bucket = aws_s3_bucket.documents.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
        Resource = [aws_s3_bucket.documents.arn, "${aws_s3_bucket.documents.arn}/*"],
        Condition = { Bool = { "aws:SecureTransport" = "false" } } },
      { Sid = "DenyUnencryptedObjectUploads", Effect = "Deny", Principal = "*", Action = "s3:PutObject",
        Resource = "${aws_s3_bucket.documents.arn}/*",
        Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "aws:kms" } } },
    ]
  })
}

resource "aws_security_group" "alb" {
    name_prefix = "${local.name}-alb-"
  vpc_id = aws_vpc.main.id
  ingress {
  from_port = 443
  to_port = 443
  protocol = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
}
  ingress {
  from_port = 80
  to_port = 80
  protocol = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
}
  egress {
  from_port = 8787
  to_port = 8787
  protocol = "tcp"
  cidr_blocks = [aws_vpc.main.cidr_block]
}
}
resource "aws_security_group" "tasks" {
    name_prefix = "${local.name}-tasks-"
  vpc_id = aws_vpc.main.id
  ingress {
  from_port = 8787
  to_port = 8787
  protocol = "tcp"
  security_groups = [aws_security_group.alb.id]
}
  egress {
  from_port = 0
  to_port = 0
  protocol = "-1"
  cidr_blocks = ["0.0.0.0/0"]
}
}
resource "aws_security_group" "db" {
    name_prefix = "${local.name}-db-"
  vpc_id = aws_vpc.main.id
  ingress {
  from_port = 5432
  to_port = 5432
  protocol = "tcp"
  security_groups = [aws_security_group.tasks.id]
}
  egress {
  from_port = 0
  to_port = 0
  protocol = "-1"
  cidr_blocks = ["0.0.0.0/0"]
}
}

resource "aws_db_subnet_group" "main" {
  name = local.name
  subnet_ids = aws_subnet.private[*].id
}
resource "aws_db_parameter_group" "postgres" {
    name_prefix = "${local.name}-"
  family = "postgres16"
  parameter {
  name = "rds.force_ssl"
  value = "1"
}
  parameter {
  name = "log_connections"
  value = "1"
}
  parameter {
  name = "log_disconnections"
  value = "1"
}
}
resource "aws_db_instance" "postgres" {
    count = var.deploy_paid_infrastructure ? 1 : 0
    identifier = local.name
  engine = "postgres"
  engine_version = "16"
  instance_class = var.db_instance_class
  db_name = var.db_name
  username = "fableadmin"
  manage_master_user_password = true
  master_user_secret_kms_key_id = aws_kms_key.phi.arn
  allocated_storage = var.db_allocated_storage
  max_allocated_storage = var.db_allocated_storage * 5
  storage_type = "gp3"
  storage_encrypted = true
  kms_key_id = aws_kms_key.phi.arn
  multi_az = var.db_multi_az
  publicly_accessible = false
  db_subnet_group_name = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name = aws_db_parameter_group.postgres.name
  backup_retention_period = 14
  backup_window = "04:00-05:00"
  maintenance_window = "sun:06:00-sun:07:00"
  deletion_protection = var.deletion_protection
  skip_final_snapshot = false
  final_snapshot_identifier = "${local.name}-final"
  performance_insights_enabled = true
  performance_insights_kms_key_id = aws_kms_key.phi.arn
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  auto_minor_version_upgrade = true
  apply_immediately = false
}

resource "aws_cloudwatch_log_group" "app" {
  name = "/ecs/${local.name}/app"
  retention_in_days = var.log_retention_days
}
resource "aws_cloudwatch_log_group" "scheduler" {
  name = "/ecs/${local.name}/scheduler"
  retention_in_days = var.log_retention_days
}
resource "aws_cloudwatch_log_group" "migration" {
  name = "/ecs/${local.name}/migration"
  retention_in_days = var.log_retention_days
}
resource "aws_ecs_cluster" "main" {
    name = local.name
  setting {
  name = "containerInsights"
  value = "enabled"
}
}

resource "aws_iam_role" "execution" {
    name_prefix = "${local.name}-execution-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "execution" {
    role = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "execution_secrets" {
    role = aws_iam_role.execution.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = compact([
      var.runtime_db_password_secret_arn, var.session_secret_arn,
      var.data_encryption_key_secret_arn, var.smtp_secret_arn,
      try(aws_db_instance.postgres[0].master_user_secret[0].secret_arn, ""),
    ]) },
    { Effect = "Allow", Action = ["kms:Decrypt"],
      Resource = concat(var.secret_kms_key_arns, [aws_kms_key.phi.arn]) },
  ] })
}
resource "aws_iam_role" "task" {
    name_prefix = "${local.name}-task-"
  assume_role_policy = aws_iam_role.execution.assume_role_policy
}
resource "aws_iam_role_policy" "documents" {
    role = aws_iam_role.task.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:ListBucket"], Resource = aws_s3_bucket.documents.arn },
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.documents.arn}/*" },
    { Effect = "Allow", Action = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"], Resource = aws_kms_key.phi.arn },
  ] })
}

resource "aws_lb" "app" {
    count = var.deploy_paid_infrastructure ? 1 : 0
    name = substr(local.name, 0, 32)
  internal = false
  load_balancer_type = "application"
  security_groups = [aws_security_group.alb.id]
  subnets = aws_subnet.public[*].id
  enable_deletion_protection = var.deletion_protection
  drop_invalid_header_fields = true
}
resource "aws_lb_target_group" "app" {
    count = var.deploy_paid_infrastructure ? 1 : 0
    name = substr("${local.name}-app", 0, 32)
  port = 8787
  protocol = "HTTP"
  target_type = "ip"
  vpc_id = aws_vpc.main.id
  deregistration_delay = 30
  health_check {
  path = "/healthz"
  matcher = "200"
  interval = 30
  healthy_threshold = 2
  unhealthy_threshold = 3
}
}
resource "aws_lb_listener" "https" {
    count = var.deploy_paid_infrastructure ? 1 : 0
    load_balancer_arn = aws_lb.app[0].arn
  port = 443
  protocol = "HTTPS"
  ssl_policy = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn = var.certificate_arn
  default_action {
  type = "forward"
  target_group_arn = aws_lb_target_group.app[0].arn
}
}
resource "aws_lb_listener" "http" {
    count = var.deploy_paid_infrastructure ? 1 : 0
    load_balancer_arn = aws_lb.app[0].arn
  port = 80
  protocol = "HTTP"
  default_action {
  type = "redirect"
  redirect {
  port = "443"
  protocol = "HTTPS"
  status_code = "HTTP_301"
}
}
}

resource "aws_ecs_task_definition" "app" {
    family = "${local.name}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode = "awsvpc"
  cpu = 512
  memory = 1024
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn = aws_iam_role.task.arn
  container_definitions = jsonencode([{ name = "app", image = var.app_image_uri, essential = true,
    readonlyRootFilesystem = true, environment = local.common_environment, secrets = local.common_secrets,
    portMappings = [{ containerPort = 8787, protocol = "tcp" }],
    healthCheck = { command = ["CMD-SHELL", "wget -q -O- http://localhost:8787/healthz || exit 1"], interval = 30, timeout = 5, retries = 3, startPeriod = 20 },
    linuxParameters = { initProcessEnabled = true },
    logConfiguration = { logDriver = "awslogs", options = { "awslogs-region" = var.aws_region, "awslogs-group" = aws_cloudwatch_log_group.app.name, "awslogs-stream-prefix" = "app" }
}
  }])
}
resource "aws_ecs_task_definition" "scheduler" {
    family = "${local.name}-scheduler"
  requires_compatibilities = ["FARGATE"]
  network_mode = "awsvpc"
  cpu = 512
  memory = 1024
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn = aws_iam_role.task.arn
  container_definitions = jsonencode([{ name = "scheduler", image = var.app_image_uri, essential = true,
    readonlyRootFilesystem = false, command = ["node", "src/cli.ts", "schedule"],
    environment = local.common_environment, secrets = local.common_secrets,
    linuxParameters = { initProcessEnabled = true },
    logConfiguration = { logDriver = "awslogs", options = { "awslogs-region" = var.aws_region, "awslogs-group" = aws_cloudwatch_log_group.scheduler.name, "awslogs-stream-prefix" = "scheduler" }
}
  }])
}
resource "aws_ecs_task_definition" "migration" {
    family = "${local.name}-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode = "awsvpc"
  cpu = 512
  memory = 1024
  execution_role_arn = aws_iam_role.execution.arn
  task_role_arn = aws_iam_role.task.arn
  container_definitions = jsonencode([{ name = "migration", image = var.migration_image_uri, essential = true,
    readonlyRootFilesystem = false,
    environment = [
      { name = "DB_HOST", value = try(aws_db_instance.postgres[0].address, "") }, { name = "DB_PORT", value = "5432" },
      { name = "DB_NAME", value = var.db_name }, { name = "DB_ADMIN_USER", value = try(aws_db_instance.postgres[0].username, "") },
      { name = "DB_RUNTIME_USER", value = var.runtime_db_user }, { name = "PGSSLMODE", value = "verify-full" },
    ],
    secrets = [
      { name = "DB_ADMIN_PASSWORD", valueFrom = "${try(aws_db_instance.postgres[0].master_user_secret[0].secret_arn, "")}:password::" },
      { name = "DB_RUNTIME_PASSWORD", valueFrom = "${var.runtime_db_password_secret_arn}:password::" },
    ],
    linuxParameters = { initProcessEnabled = true },
    logConfiguration = { logDriver = "awslogs", options = { "awslogs-region" = var.aws_region, "awslogs-group" = aws_cloudwatch_log_group.migration.name, "awslogs-stream-prefix" = "migration" }
}
  }])
}

resource "aws_ecs_service" "app" {
    name = "app"
  cluster = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count = var.services_enabled ? var.app_desired_count : 0
  launch_type = "FARGATE"
  enable_execute_command = false
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent = 200
  network_configuration {
  subnets = aws_subnet.private[*].id
  security_groups = [aws_security_group.tasks.id]
  assign_public_ip = false
}
  dynamic "load_balancer" {
    for_each = var.deploy_paid_infrastructure ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.app[0].arn
      container_name    = "app"
      container_port    = 8787
    }
  }
  depends_on = [aws_lb_listener.https]
}
resource "aws_ecs_service" "scheduler" {
    name = "scheduler"
  cluster = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.scheduler.arn
  desired_count = var.services_enabled ? 1 : 0
  launch_type = "FARGATE"
  enable_execute_command = false
  network_configuration {
  subnets = aws_subnet.private[*].id
  security_groups = [aws_security_group.tasks.id]
  assign_public_ip = false
}
}
resource "aws_appautoscaling_target" "app" {
    max_capacity = 4
  min_capacity = var.services_enabled ? 2 : 0
  resource_id = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace = "ecs"
}
resource "aws_appautoscaling_policy" "cpu" {
    name = "${local.name}-cpu"
  policy_type = "TargetTrackingScaling"
  resource_id = aws_appautoscaling_target.app.resource_id
  scalable_dimension = aws_appautoscaling_target.app.scalable_dimension
  service_namespace = aws_appautoscaling_target.app.service_namespace
  target_tracking_scaling_policy_configuration {
  target_value = 60
  predefined_metric_specification {
  predefined_metric_type = "ECSServiceAverageCPUUtilization"
}
}
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
    count = var.deploy_paid_infrastructure ? 1 : 0
    alarm_name = "${local.name}-alb-5xx"
  namespace = "AWS/ApplicationELB"
  metric_name = "HTTPCode_Target_5XX_Count"
  statistic = "Sum"
  period = 300
  evaluation_periods = 1
  threshold = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  dimensions = { LoadBalancer = aws_lb.app[0].arn_suffix
}
  alarm_actions = local.alarm_arns
}
resource "aws_cloudwatch_metric_alarm" "db_cpu" {
    count = var.deploy_paid_infrastructure ? 1 : 0
    alarm_name = "${local.name}-db-cpu"
  namespace = "AWS/RDS"
  metric_name = "CPUUtilization"
  statistic = "Average"
  period = 300
  evaluation_periods = 3
  threshold = 80
  comparison_operator = "GreaterThanThreshold"
  dimensions = { DBInstanceIdentifier = aws_db_instance.postgres[0].id
}
  alarm_actions = local.alarm_arns
}
resource "aws_cloudwatch_metric_alarm" "db_storage" {
    count = var.deploy_paid_infrastructure ? 1 : 0
    alarm_name = "${local.name}-db-free-storage"
  namespace = "AWS/RDS"
  metric_name = "FreeStorageSpace"
  statistic = "Average"
  period = 300
  evaluation_periods = 1
  threshold = 10737418240
  comparison_operator = "LessThanThreshold"
  dimensions = { DBInstanceIdentifier = aws_db_instance.postgres[0].id
}
  alarm_actions = local.alarm_arns
}
