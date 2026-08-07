output "state_bucket_name" {
  value = aws_s3_bucket.state.id
}
output "lock_table_name" {
  value = aws_dynamodb_table.lock.name
}
output "state_kms_key_arn" {
  value = aws_kms_key.state.arn
}
