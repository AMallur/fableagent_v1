# ============================================================================
# Optional pilot hardening that is fully expressible as code but should only be
# enabled/applied when the account is ready. Nothing in this file is created by
# merely committing it to Git.
# ============================================================================

variable "enable_edge_waf" {
  type        = bool
  default     = false
  description = "Attach a baseline AWS WAFv2 policy to the public ALB. Enable before exposing a PHI-capable production endpoint."
}

variable "enable_interface_endpoints" {
  type        = bool
  default     = false
  description = "Create paid Interface VPC Endpoints for AWS control-plane dependencies. Use with a restricted-egress plan; false keeps pilot fixed cost down until needed."
}

# ---------------------------------------------------------------------------
# WAF: intentionally small baseline. Start in count mode during pre-production
# if the customer's traffic is unusual, then tune before enabling autonomous
# blocking. The rate rule protects obvious abuse without replacing API-level
# per-key limits already enforced by FableAgent.
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "app" {
  count = var.enable_edge_waf ? 1 : 0

  name  = "${local.name}-web-acl"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-common"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-aws-common"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "aws-known-bad-inputs"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-known-bad-inputs"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "aws-ip-reputation"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-ip-reputation"
      sampled_requests_enabled   = false
    }
  }

  rule {
    name     = "per-ip-rate-limit"
    priority = 40

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-limit"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-web-acl"
    sampled_requests_enabled   = false
  }
}

resource "aws_wafv2_web_acl_association" "app" {
  count        = var.enable_edge_waf && var.deploy_paid_infrastructure ? 1 : 0
  resource_arn = aws_lb.app[0].arn
  web_acl_arn  = aws_wafv2_web_acl.app[0].arn
}

resource "aws_cloudwatch_log_group" "waf" {
  count             = var.enable_edge_waf ? 1 : 0
  name              = "aws-waf-logs-${local.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_wafv2_web_acl_logging_configuration" "app" {
  count                   = var.enable_edge_waf ? 1 : 0
  resource_arn            = aws_wafv2_web_acl.app[0].arn
  log_destination_configs = [aws_cloudwatch_log_group.waf[0].arn]

  # Do not retain authorization/cookie material in WAF logs.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }

  redacted_fields {
    single_header {
      name = "x-api-key"
    }
  }
}

# ---------------------------------------------------------------------------
# Interface endpoints. The existing S3 gateway endpoint is free; these
# interface endpoints incur hourly/data charges, so they are opt-in. Once the
# app's external destinations are known, they provide the AWS-private half of
# a tighter egress policy for ECS tasks.
# ---------------------------------------------------------------------------

resource "aws_security_group" "vpc_endpoints" {
  count       = var.enable_interface_endpoints ? 1 : 0
  name_prefix = "${local.name}-vpce-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.tasks.id]
  }

  egress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }
}

locals {
  interface_endpoint_services = toset([
    "ecr.api",
    "ecr.dkr",
    "secretsmanager",
    "logs",
    "kms",
    "sts",
  ])
}

resource "aws_vpc_endpoint" "interface" {
  for_each = var.enable_interface_endpoints ? local.interface_endpoint_services : toset([])

  vpc_id              = aws_vpc.main.id
  service_name        = "com.amazonaws.${var.aws_region}.${each.value}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints[0].id]
}

# ---------------------------------------------------------------------------
# Additional operational alarms. These use the existing alarm_topic_arn hook
# and therefore remain notification-inert when no topic is configured.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_unhealthy_targets" {
  count               = var.deploy_paid_infrastructure ? 1 : 0
  alarm_name          = "${local.name}-alb-unhealthy-targets"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.app[0].arn_suffix
    TargetGroup  = aws_lb_target_group.app[0].arn_suffix
  }

  alarm_actions = local.alarm_arns
}

resource "aws_cloudwatch_metric_alarm" "alb_latency" {
  count               = var.deploy_paid_infrastructure ? 1 : 0
  alarm_name          = "${local.name}-alb-target-latency"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.app[0].arn_suffix
  }

  alarm_actions = local.alarm_arns
}

resource "aws_cloudwatch_metric_alarm" "db_freeable_memory" {
  count               = var.deploy_paid_infrastructure ? 1 : 0
  alarm_name          = "${local.name}-db-freeable-memory"
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 268435456
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres[0].id
  }

  alarm_actions = local.alarm_arns
}
