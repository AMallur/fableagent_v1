-- ============================================================================
-- 0012_automation_notifications.sql
-- Automation & scheduling layer (engine/src/automation):
--   * per-client schedule config (nightly run time, timezone, ingest folder)
--   * notification + notification_preference + email_outbox
--   * automation_rule + rule_execution (admin-configured WHEN/AND/THEN rules)
--   * dashboard_snapshot — nightly per-client rollup (trend history)
--   * new job types for the orchestrated jobs
-- ============================================================================

BEGIN;

-- new values are not used inside this transaction (PG12+ requirement)
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'nightly_processing';
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'deadline_monitor';
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'weekly_summary';

-- ----------------------------------------------------------------------------
-- schedule configuration per client
-- ----------------------------------------------------------------------------
ALTER TABLE client
  ADD COLUMN nightly_run_time time NOT NULL DEFAULT '02:00',
  ADD COLUMN timezone text NOT NULL DEFAULT 'America/New_York',
  ADD COLUMN ingest_folder text;          -- NULL = var/ingest/<client_id>

-- deadline-monitor + rule-engine flags
ALTER TABLE recovery_case
  ADD COLUMN same_day_action boolean NOT NULL DEFAULT false,
  ADD COLUMN flagged_for_review boolean NOT NULL DEFAULT false;

-- per-user digest cadence
ALTER TABLE app_user
  ADD COLUMN digest_frequency text NOT NULL DEFAULT 'daily'
    CHECK (digest_frequency IN ('daily', 'weekly', 'off'));

-- ----------------------------------------------------------------------------
-- NOTIFICATION — in-app notification center rows. email_disposition is
-- resolved from the user's preference at creation time; the digest job
-- collects 'digest' rows, urgent rows go to the outbox immediately.
-- ----------------------------------------------------------------------------
CREATE TABLE notification (
  notification_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenant (tenant_id),
  user_id            uuid        NOT NULL REFERENCES app_user (user_id),
  notification_type  text        NOT NULL CHECK (notification_type IN
    ('case_assigned', 'deadline_approaching', 'payment_received', 'new_cases',
     'job_summary', 'system_alert', 'rule_notification')),
  severity           text        NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'urgent')),
  title              text        NOT NULL,
  body               text,
  case_id            uuid REFERENCES recovery_case (case_id),
  email_disposition  text        NOT NULL DEFAULT 'digest'
    CHECK (email_disposition IN ('immediate', 'digest', 'off')),
  dedupe_key         text,
  read_at            timestamptz,
  digested_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_user_unread ON notification (user_id, created_at DESC)
  WHERE read_at IS NULL;
CREATE INDEX idx_notification_user ON notification (user_id, created_at DESC);
CREATE INDEX idx_notification_digest ON notification (tenant_id, user_id)
  WHERE email_disposition = 'digest' AND digested_at IS NULL;
CREATE UNIQUE INDEX uq_notification_dedupe ON notification (tenant_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- ----------------------------------------------------------------------------
-- NOTIFICATION_PREFERENCE — per user, per type
-- ----------------------------------------------------------------------------
CREATE TABLE notification_preference (
  preference_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenant (tenant_id),
  user_id            uuid        NOT NULL REFERENCES app_user (user_id),
  notification_type  text        NOT NULL,
  in_app             boolean     NOT NULL DEFAULT true,
  email              text        NOT NULL DEFAULT 'digest'
    CHECK (email IN ('immediate', 'digest', 'off')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, notification_type)
);

CREATE INDEX idx_notification_pref_user ON notification_preference (user_id);

-- ----------------------------------------------------------------------------
-- EMAIL_OUTBOX — the delivery queue. A transport adapter (SMTP/SES/…) drains
-- 'queued' rows; environments without one still have a complete, auditable
-- record of what would be sent.
-- ----------------------------------------------------------------------------
CREATE TABLE email_outbox (
  email_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenant (tenant_id),
  user_id     uuid REFERENCES app_user (user_id),
  to_email    text        NOT NULL,
  subject     text        NOT NULL,
  body_text   text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('immediate', 'digest', 'weekly_report')),
  status      text        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'failed')),
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);

CREATE INDEX idx_outbox_queued ON email_outbox (created_at) WHERE status = 'queued';
CREATE INDEX idx_outbox_tenant ON email_outbox (tenant_id, created_at DESC);

-- ----------------------------------------------------------------------------
-- AUTOMATION_RULE — WHEN [trigger] AND [conditions] THEN [actions]
--   trigger_param: {"days": 7} for deadline_approaching
--   conditions:    [{"field":"recovery_opportunity","op":"gt","value":1000}, …]  (ANDed)
--   actions:       [{"type":"assign_to","userId":"…"},
--                   {"type":"notify","userId":"…"} | {"type":"notify","role":"biller"},
--                   {"type":"set_priority","level":"critical"},
--                   {"type":"add_to_submission_queue"},
--                   {"type":"flag_for_review"}]
-- ----------------------------------------------------------------------------
CREATE TABLE automation_rule (
  rule_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenant (tenant_id),
  client_id      uuid,                   -- NULL = applies tenant-wide
  name           text        NOT NULL,
  trigger        text        NOT NULL CHECK (trigger IN
    ('case_created', 'deadline_approaching', 'payment_received',
     'status_changed', 'document_uploaded')),
  trigger_param  jsonb       NOT NULL DEFAULT '{}',
  conditions     jsonb       NOT NULL DEFAULT '[]',
  actions        jsonb       NOT NULL DEFAULT '[]',
  enabled        boolean     NOT NULL DEFAULT true,
  created_by     uuid REFERENCES app_user (user_id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,

  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE INDEX idx_rule_tenant_trigger ON automation_rule (tenant_id, trigger)
  WHERE enabled AND deleted_at IS NULL;

CREATE TRIGGER trg_audit_automation_rule
  AFTER INSERT OR UPDATE OR DELETE ON automation_rule
  FOR EACH ROW EXECUTE FUNCTION app.write_audit('rule_id');

-- ----------------------------------------------------------------------------
-- RULE_EXECUTION — operational log of every rule firing (the audit_log also
-- receives a 'rule_executed' entry). The partial unique index prevents a
-- deadline_approaching rule from re-firing daily on the same case.
-- ----------------------------------------------------------------------------
CREATE TABLE rule_execution (
  execution_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenant (tenant_id),
  rule_id          uuid        NOT NULL REFERENCES automation_rule (rule_id),
  case_id          uuid        NOT NULL REFERENCES recovery_case (case_id),
  trigger          text        NOT NULL,
  actions_applied  jsonb       NOT NULL DEFAULT '[]',
  executed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_rule_execution_tenant ON rule_execution (tenant_id, executed_at DESC);
CREATE INDEX idx_rule_execution_rule ON rule_execution (rule_id);
CREATE UNIQUE INDEX uq_rule_execution_deadline
  ON rule_execution (rule_id, case_id) WHERE trigger = 'deadline_approaching';

-- ----------------------------------------------------------------------------
-- DASHBOARD_SNAPSHOT — nightly per-client rollup written by step 11 of the
-- nightly pipeline; preserves trend history independent of live queries.
-- ----------------------------------------------------------------------------
CREATE TABLE dashboard_snapshot (
  snapshot_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL,
  client_id         uuid        NOT NULL,
  snapshot_date     date        NOT NULL,
  open_cases        integer     NOT NULL DEFAULT 0,
  open_amount       numeric(14,2) NOT NULL DEFAULT 0,
  due_within_7      integer     NOT NULL DEFAULT 0,
  recovered_total   numeric(14,2) NOT NULL DEFAULT 0,
  recovered_30d     numeric(14,2) NOT NULL DEFAULT 0,
  cases_won_total   integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  UNIQUE (client_id, snapshot_date),
  FOREIGN KEY (tenant_id, client_id) REFERENCES client (tenant_id, client_id)
);

CREATE INDEX idx_snapshot_client ON dashboard_snapshot (client_id, snapshot_date DESC);

-- ----------------------------------------------------------------------------
-- RLS, updated_at triggers, grants for the new tables
-- ----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'notification_preference', 'email_outbox',
                           'automation_rule', 'rule_execution', 'dashboard_snapshot']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL
       USING (tenant_id = app.current_tenant_id())
       WITH CHECK (tenant_id = app.current_tenant_id())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['notification', 'notification_preference',
                           'automation_rule', 'dashboard_snapshot']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON notification, notification_preference, email_outbox,
  automation_rule, rule_execution, dashboard_snapshot TO rcm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON notification, notification_preference,
  email_outbox, automation_rule, rule_execution, dashboard_snapshot TO rcm_service;

COMMIT;
