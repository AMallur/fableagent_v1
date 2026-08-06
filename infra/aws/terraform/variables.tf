variable "aws_region" {
  type = string
}
variable "project_name" {
  type = string
  default = "fableagent"
}
variable "environment" {
  type = string
  default = "pilot"
}
variable "app_image_uri" {
    type        = string
  description = "Immutable runtime image URI, preferably an ECR digest"
}
variable "migration_image_uri" {
    type        = string
  description = "Immutable migrate-stage image URI built from infra/aws/Dockerfile"
}
variable "certificate_arn" {
    type        = string
  description = "Validated ACM certificate ARN for the application hostname"
}
variable "runtime_db_password_secret_arn" {
    type        = string
  description = "Secrets Manager secret containing JSON key password for fable_runtime"
}
variable "session_secret_arn" {
    type        = string
  description = "Secrets Manager secret containing JSON key value (32+ random bytes)"
}
variable "data_encryption_key_secret_arn" {
    type        = string
  description = "Secrets Manager secret containing JSON key value (32+ random bytes)"
}
variable "smtp_secret_arn" {
    type        = string
  default     = ""
  description = "Optional Secrets Manager JSON with host, port, user, password, from"
}
variable "runtime_db_user" {
  type = string
  default = "fable_runtime"
}
variable "db_name" {
  type = string
  default = "fableagent"
}
variable "db_instance_class" {
  type = string
  default = "db.t4g.medium"
}
variable "db_allocated_storage" {
  type = number
  default = 100
}
variable "db_multi_az" {
  type = bool
  default = true
}
variable "deletion_protection" {
  type = bool
  default = true
}
variable "app_desired_count" {
  type = number
  default = 2
}
variable "services_enabled" {
    type        = bool
  default     = false
  description = "Set false for the first apply, run migration task, then set true"
}
variable "secret_kms_key_arns" {
    type        = list(string)
  description = "Customer-managed KMS keys encrypting the supplied Secrets Manager secrets"
}
variable "log_retention_days" {
  type = number
  default = 365
}
variable "alarm_topic_arn" {
    type        = string
  default     = ""
  description = "Optional SNS topic ARN for operational alarms"
}
