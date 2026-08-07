# ============================================================================
# One-time bootstrap for the main stack's Terraform remote state.
#
# Run this BEFORE `terraform init` in ../ (the main config) — its S3 backend
# points at the bucket/table this creates, and a backend block cannot
# reference resources from its own configuration (chicken-and-egg: something
# has to create the state bucket before Terraform can track state in it).
#
# This module deliberately keeps its own state local, not remote. It manages
# exactly two resources that essentially never change after creation, so the
# problem a remote backend solves (concurrent-apply corruption, state as a
# single point of failure on one laptop) barely applies here, and adding a
# backend-for-the-backend just relocates the same bootstrapping problem
# instead of solving it.
#
# Usage:
#   cd infra/aws/terraform/bootstrap
#   terraform init
#   terraform apply -var aws_region=us-east-1
#
#   cd ../                    # the main config
#   terraform init \
#     -backend-config="bucket=$(terraform -chdir=../bootstrap output -raw state_bucket_name)" \
#     -backend-config="dynamodb_table=$(terraform -chdir=../bootstrap output -raw lock_table_name)" \
#     -backend-config="region=us-east-1" \
#     -backend-config="key=fableagent/terraform.tfstate"
# ============================================================================

resource "aws_kms_key" "state" {
  description             = "${var.project_name} Terraform state encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_s3_bucket" "state" {
  bucket_prefix = "${var.project_name}-tfstate-"
  force_destroy = false
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration { status = "Enabled" }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    bucket_key_enabled = true
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
  }
}
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Sid      = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*",
        Resource = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"],
      Condition = { Bool = { "aws:SecureTransport" = "false" } } },
    ]
  })
}

resource "aws_dynamodb_table" "lock" {
  name         = "${var.project_name}-tfstate-lock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute {
    name = "LockID"
    type = "S"
  }
  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.state.arn
  }
}
