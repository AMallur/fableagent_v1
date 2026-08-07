# Remote state backend. Deliberately left as a partial configuration — the
# bucket/table/region below are account- and environment-specific and must
# never be hardcoded into a config meant to be reused across environments.
# Supply them via `-backend-config` flags or a `backend.hcl` file at
# `terraform init` time. See terraform/bootstrap/main.tf for how to create
# the bucket and lock table this points at, and ../README.md for the exact
# init command.
terraform {
  backend "s3" {
    encrypt = true
  }
}
