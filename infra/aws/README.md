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

1. One-time only: bootstrap the remote state backend (a versioned, KMS-encrypted
   S3 bucket plus a DynamoDB lock table). This has to happen before the main
   config's `terraform init`, since a backend block cannot reference resources
   from its own configuration:

   ```sh
   cd terraform/bootstrap
   terraform init
   terraform apply -var aws_region=us-east-1
   cd ..
   terraform init \
     -backend-config="bucket=$(terraform -chdir=bootstrap output -raw state_bucket_name)" \
     -backend-config="dynamodb_table=$(terraform -chdir=bootstrap output -raw lock_table_name)" \
     -backend-config="region=us-east-1" \
     -backend-config="key=fableagent/terraform.tfstate"
   ```

   `terraform/bootstrap` deliberately keeps its own local state — see the
   comment at the top of `terraform/bootstrap/main.tf` for why.

2. Copy `terraform/terraform.tfvars.example` to an untracked `.tfvars` file.
   Keep `services_enabled = false` for the first apply.
3. Run `terraform plan` and `terraform apply` from the `terraform` directory.
4. Run the migration task on the private subnets:

   ```sh
   aws ecs run-task \
     --cluster "$(terraform output -raw ecs_cluster_arn)" \
     --task-definition "$(terraform output -raw migration_task_definition_arn)" \
     --launch-type FARGATE \
     --network-configuration "awsvpcConfiguration={subnets=[$(terraform output -json private_subnet_ids | jq -r 'join(",")')],securityGroups=[$(terraform output -raw task_security_group_id)],assignPublicIp=DISABLED}"
   ```

5. Wait for the task to stop, require exit code 0, and review the migration
   CloudWatch log. The task creates/rotates the non-superuser runtime login,
   applies all migrations as that login, and revokes migration-only owner-role
   membership.
6. Set `services_enabled = true`, apply again, point DNS at the load balancer,
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
- Before live PHI, also complete the organizational HIPAA risk analysis,
  written policies, workforce training, incident response plan, and access-
  review process (`docs/PRODUCTION_READINESS.md` gate 8) and run tested
  backup/restore and disaster-recovery exercises (gate 7) against this
  account. Those are process/verification steps this Terraform stack cannot
  perform on its own, even once the controls below exist.

The Terraform stack includes RDS Multi-AZ by default, encryption, 14-day
automated backups, deletion protection, S3 Block Public Access, S3 versioning,
KMS rotation, private tasks/database, least-purpose task IAM, CloudWatch logs,
Container Insights, autoscaling, and initial ALB/RDS alarms.

`security.tf` adds the account-level controls docs/PRODUCTION_READINESS.md
gate 11 calls out: a multi-region CloudTrail (with log file validation) and
AWS Config recorder writing to a dedicated, versioned, SSE-encrypted audit
bucket separate from the PHI documents bucket; GuardDuty; Security Hub
subscribed to the AWS Foundational Security Best Practices standard; and
three starting Config rules (S3 encryption, S3 public-read, RDS encryption).
This is a starting posture, not a full compliance conformance pack — see the
comment above the Config rules in `security.tf` for what to layer on once
there's a compliance program in place to act on findings. GuardDuty's
high-severity findings forward to `var.alarm_topic_arn` when one is
configured (that topic's own resource policy must separately allow the
`events.amazonaws.com` principal to publish).
