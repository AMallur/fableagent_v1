output "load_balancer_dns_name" {
  value = try(aws_lb.app[0].dns_name, null)
}
output "document_bucket" {
  value = aws_s3_bucket.documents.id
}
output "document_kms_key_arn" {
  value = aws_kms_key.phi.arn
}
output "rds_endpoint" {
  value = try(aws_db_instance.postgres[0].address, null)
}
output "rds_admin_secret_arn" {
  value     = try(aws_db_instance.postgres[0].master_user_secret[0].secret_arn, null)
  sensitive = true
}
output "ecs_cluster_arn" {
  value = aws_ecs_cluster.main.arn
}
output "migration_task_definition_arn" {
  value = aws_ecs_task_definition.migration.arn
}
output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}
output "task_security_group_id" {
  value = aws_security_group.tasks.id
}
output "cloudtrail_arn" {
  value = aws_cloudtrail.main.arn
}
output "guardduty_detector_id" {
  value = aws_guardduty_detector.main.id
}
output "config_recorder_name" {
  value = aws_config_configuration_recorder.main.name
}
output "audit_logs_bucket" {
  value = aws_s3_bucket.audit_logs.id
}
