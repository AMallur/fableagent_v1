# ============================================================================
# Account-level audit and threat-detection controls: CloudTrail, GuardDuty,
# AWS Config, Security Hub. This is the Terraform half of the account
# controls docs/PRODUCTION_READINESS.md gate 11 calls out as required and
# explicitly NOT establishable by the application stack itself.
#
# CloudTrail/Config log API-call and configuration METADATA (who called
# what, when, from where) — not PHI. They get their own bucket, deliberately
# separate from the documents bucket, encrypted with SSE-S3 rather than the
# PHI KMS key: these logs aren't PHI, and granting CloudTrail's/Config's
# service principals decrypt rights on the PHI key would be an unnecessary
# widening of that key's blast radius for no benefit.
# ============================================================================

resource "aws_s3_bucket" "audit_logs" {
  bucket_prefix = "${local.name}-audit-logs-"
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "audit_logs" {
  bucket                  = aws_s3_bucket.audit_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "audit_logs" {
  bucket = aws_s3_bucket.audit_logs.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "audit_logs" {
  bucket = aws_s3_bucket.audit_logs.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "audit_logs" {
  bucket = aws_s3_bucket.audit_logs.id
  rule {
    id     = "retention"
    status = "Enabled"
    filter {}
    # 7 years is a common healthcare-org audit-log retention floor, not a
    # cited legal requirement for this specific log type — confirm the
    # actual figure against your own compliance program before relying on it.
    expiration { days = 2555 }
    noncurrent_version_expiration { noncurrent_days = 2555 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
  depends_on = [aws_s3_bucket_versioning.audit_logs]
}
resource "aws_s3_bucket_policy" "audit_logs" {
  bucket = aws_s3_bucket.audit_logs.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid      = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
        Resource = [aws_s3_bucket.audit_logs.arn, "${aws_s3_bucket.audit_logs.arn}/*"],
      Condition = { Bool = { "aws:SecureTransport" = "false" } } },
      { Sid       = "AWSCloudTrailAclCheck", Effect = "Allow",
        Principal = { Service = "cloudtrail.amazonaws.com" }, Action = "s3:GetBucketAcl",
      Resource = aws_s3_bucket.audit_logs.arn },
      { Sid       = "AWSCloudTrailWrite", Effect = "Allow",
        Principal = { Service = "cloudtrail.amazonaws.com" }, Action = "s3:PutObject",
        Resource  = "${aws_s3_bucket.audit_logs.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*",
        Condition = { StringEquals = {
          "s3:x-amz-acl" = "bucket-owner-full-control",
          "aws:SourceArn" = "arn:aws:cloudtrail:${var.aws_region}:${data.aws_caller_identity.current.account_id}:trail/${local.name}-trail"
        } } },
      { Sid       = "AWSConfigAclCheck", Effect = "Allow",
        Principal = { Service = "config.amazonaws.com" }, Action = "s3:GetBucketAcl",
      Resource = aws_s3_bucket.audit_logs.arn },
      { Sid       = "AWSConfigWrite", Effect = "Allow",
        Principal = { Service = "config.amazonaws.com" }, Action = "s3:PutObject",
        Resource  = "${aws_s3_bucket.audit_logs.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/Config/*",
      Condition = { StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control" } } },
    ]
  })
}

resource "aws_cloudtrail" "main" {
  name                          = "${local.name}-trail"
  s3_bucket_name                = aws_s3_bucket.audit_logs.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true

  # Management events provide account/infra auditability. S3 data events add
  # object-level Get/Put/Delete evidence for the PHI documents bucket; these
  # are not enabled by default on a normal CloudTrail trail.
  event_selector {
    read_write_type           = "All"
    include_management_events = true
    data_resource {
      type   = "AWS::S3::Object"
      values = ["${aws_s3_bucket.documents.arn}/"]
    }
  }

  depends_on = [aws_s3_bucket_policy.audit_logs]
}

resource "aws_guardduty_detector" "main" {
  enable                       = true
  finding_publishing_frequency = "FIFTEEN_MINUTES"
}

resource "aws_iam_role" "config" {
  name_prefix        = "${local.name}-config-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "config.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "config" {
  role       = aws_iam_role.config.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}
resource "aws_iam_role_policy" "config_s3" {
  role = aws_iam_role.config.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect   = "Allow", Action = ["s3:PutObject"],
      Resource = "${aws_s3_bucket.audit_logs.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/Config/*",
    Condition = { StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control" } } },
    { Effect = "Allow", Action = ["s3:GetBucketAcl"], Resource = aws_s3_bucket.audit_logs.arn },
  ] })
}

resource "aws_config_configuration_recorder" "main" {
  name     = local.name
  role_arn = aws_iam_role.config.arn
  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}
resource "aws_config_delivery_channel" "main" {
  name           = local.name
  s3_bucket_name = aws_s3_bucket.audit_logs.id
  s3_key_prefix  = "AWSLogs/${data.aws_caller_identity.current.account_id}/Config"
  depends_on     = [aws_s3_bucket_policy.audit_logs]
}
resource "aws_config_configuration_recorder_status" "main" {
  name       = aws_config_configuration_recorder.main.name
  is_enabled = true
  depends_on = [aws_config_delivery_channel.main]
}

# Deliberately-scoped managed rules for controls this stack claims. Expand only
# when there is an operational owner for findings/remediation.
resource "aws_config_config_rule" "s3_encrypted" {
  name = "${local.name}-s3-bucket-server-side-encryption-enabled"
  source {
    owner             = "AWS"
    source_identifier = "S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED"
  }
  depends_on = [aws_config_configuration_recorder.main]
}
resource "aws_config_config_rule" "s3_public_read_prohibited" {
  name = "${local.name}-s3-bucket-public-read-prohibited"
  source {
    owner             = "AWS"
    source_identifier = "S3_BUCKET_PUBLIC_READ_PROHIBITED"
  }
  depends_on = [aws_config_configuration_recorder.main]
}
resource "aws_config_config_rule" "s3_public_write_prohibited" {
  name = "${local.name}-s3-bucket-public-write-prohibited"
  source {
    owner             = "AWS"
    source_identifier = "S3_BUCKET_PUBLIC_WRITE_PROHIBITED"
  }
  depends_on = [aws_config_configuration_recorder.main]
}
resource "aws_config_config_rule" "rds_encrypted" {
  name = "${local.name}-rds-storage-encrypted"
  source {
    owner             = "AWS"
    source_identifier = "RDS_STORAGE_ENCRYPTED"
  }
  depends_on = [aws_config_configuration_recorder.main]
}
resource "aws_config_config_rule" "rds_not_public" {
  name = "${local.name}-rds-instance-public-access-check"
  source {
    owner             = "AWS"
    source_identifier = "RDS_INSTANCE_PUBLIC_ACCESS_CHECK"
  }
  depends_on = [aws_config_configuration_recorder.main]
}
resource "aws_config_config_rule" "rds_multi_az" {
  name = "${local.name}-rds-multi-az-support"
  source {
    owner             = "AWS"
    source_identifier = "RDS_MULTI_AZ_SUPPORT"
  }
  depends_on = [aws_config_configuration_recorder.main]
}
resource "aws_config_config_rule" "multi_region_cloudtrail" {
  name = "${local.name}-multi-region-cloudtrail-enabled"
  source {
    owner             = "AWS"
    source_identifier = "MULTI_REGION_CLOUD_TRAIL_ENABLED"
  }
  depends_on = [aws_config_configuration_recorder.main, aws_cloudtrail.main]
}

resource "aws_securityhub_account" "main" {}
resource "aws_securityhub_standards_subscription" "foundational" {
  standards_arn = "arn:aws:securityhub:${var.aws_region}::standards/aws-foundational-security-best-practices/v/1.0.0"
  depends_on    = [aws_securityhub_account.main]
}

# Optional: forward high-severity GuardDuty findings to the existing
# operational alarm topic (the same var.alarm_topic_arn CloudWatch alarms
# already use). Inert (creates nothing) when no topic is configured.
#
# NOTE: the SNS topic behind var.alarm_topic_arn is created outside this
# stack, so its resource policy is not managed here — it must separately
# allow the events.amazonaws.com principal to publish, or EventBridge
# deliveries will silently fail. If the topic is currently only used for
# CloudWatch alarms, its policy likely needs updating.
resource "aws_cloudwatch_event_rule" "guardduty_high_severity" {
  count       = var.alarm_topic_arn == "" ? 0 : 1
  name        = "${local.name}-guardduty-high-severity"
  description = "GuardDuty findings with severity >= 7 (High/Critical)"
  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    detail        = { severity = [{ numeric = [">=", 7] }] }
  })
}
resource "aws_cloudwatch_event_target" "guardduty_to_alarm_topic" {
  count = var.alarm_topic_arn == "" ? 0 : 1
  rule  = aws_cloudwatch_event_rule.guardduty_high_severity[0].name
  arn   = var.alarm_topic_arn
}
