# AWS commercial-pilot deployment

This stack runs the FableAgent web application and scheduler on ECS Fargate,
RDS for PostgreSQL in private subnets, and appeal documents in a private,
versioned, KMS-encrypted S3 bucket. An internet-facing Application Load
Balancer terminates TLS. Secrets are injected from Secrets Manager, and the
application uses an ECS task role for S3/KMS instead of static AWS keys.

Infrastructure does not itself make an organization HIPAA compliant. Sign an
AWS BAA and restrict the account to the services and configuration covered by
it before storing PHI.

## Prerequisites

- An AWS account with Terraform state stored in a separately protected remote
  backend. This repository intentionally does not prescribe or create the
  state backend in the same stack.
- A validated ACM certificate and DNS name.
- Two immutable container images, built from the repository root:

  ```sh
  docker build -f infra/aws/Dockerfile --target runtime -t <runtime-ecr-uri> .
  docker build -f infra/aws/Dockerfile --target migrate -t <migrate-ecr-uri> .
  ```

- Existing Secrets Manager secrets, encrypted by customer-managed KMS keys:

  | Secret | JSON shape |
  |---|---|
  | runtime database | `{"password":"<random>"}` |
  | session signing | `{"value":"<32+ random bytes>"}` |
  | field encryption | `{"value":"<32+ random bytes>"}` |
  | SMTP, optional | `{"host":"...","port":"587","user":"...","password":"...","from":"..."}` |

Do not put secret values in `tfvars`: Terraform state retains variable values.

## Deployment order

1. Copy `terraform/terraform.tfvars.example` to an untracked `.tfvars` file.
   Keep `services_enabled = false` for the first apply.
2. Run `terraform init`, `terraform plan`, and `terraform apply` from the
   `terraform` directory.
3. Run the migration task on the private subnets:

   ```sh
   aws ecs run-task \
     --cluster "$(terraform output -raw ecs_cluster_arn)" \
     --task-definition "$(terraform output -raw migration_task_definition_arn)" \
     --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json private_subnet_ids | jq -r 'join(",")')],securityGroups=[$(terraform output -raw task_security_group_id)],assignPublicIp=DISABLED}"
   ```

4. Wait for the task to stop, require exit code 0, and review the migration
   CloudWatch log. The task creates/rotates the non-superuser runtime login,
   applies all migrations as that login, and revokes migration-only owner-role
   membership.
5. Set `services_enabled = true`, apply again, point DNS at the load balancer,
   and verify `/healthz`, login/MFA, a dry-run detection, and an S3 document
   round trip.

## Deliberate pilot boundaries

- The ECS stack supports HTTPS manual upload and the authenticated API. It does
  not expose the embedded SFTP server because Fargate tasks do not share its
  local ingest directory. Use a single EC2 host with `docker-compose.aws.yml`
  for a controlled SFTP pilot, or add an AWS Transfer Family-to-S3 adapter
  before promising managed SFTP.
- One NAT gateway bounds pilot cost. Use one per Availability Zone before
  promising an egress-HA SLA.
- SMTP remains disabled until a BAA-covered provider and sending domain are
  configured. Clearinghouse delivery remains review/manual until a selected
  partner's actual API and acknowledgements are certified.
- Before live PHI, enable organization-level CloudTrail, AWS Config/Security
  Hub controls, GuardDuty, central log retention, tested restore, and alarm
  routing in the customer's AWS organization. These are account controls, not
  application code.

The Terraform stack includes RDS Multi-AZ by default, encryption, 14-day
automated backups, deletion protection, S3 Block Public Access, S3 versioning,
KMS rotation, private tasks/database, least-purpose task IAM, CloudWatch logs,
Container Insights, autoscaling, and initial ALB/RDS alarms.
