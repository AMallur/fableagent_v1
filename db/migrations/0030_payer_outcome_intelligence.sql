-- ============================================================================
-- 0030_payer_outcome_intelligence.sql
--
-- The payer-outcome data flywheel.
--
-- 0029 gave appeal_packet the ability to RECORD what happened to a specific
-- appeal (outcome, outcome_amount) and which argument it made (letter_category).
-- On its own that is just history sitting in a table. The flywheel is the loop
-- that turns that history into a decision: as recorded outcomes accumulate, the
-- system learns how a given payer actually behaves toward a given argument at a
-- given appeal level, and feeds that back into how the next appeal is prepared
-- and prioritized. More appeals -> more recorded outcomes -> sharper behavior
-- estimates -> better-targeted appeals -> more recovered dollars -> more appeals.
--
-- The statistics themselves are computed live from appeal_packet (see
-- engine/src/intelligence): no denormalized aggregate table is stored, because
-- an outcome that lands today must immediately sharpen tomorrow's estimate, and
-- a cached rollup would go stale the moment a payer answers. This migration adds
-- only two things:
--
--   1. appeal_packet.intelligence -- a JSONB SNAPSHOT of the flywheel's read at
--      the moment the packet was generated: the payer/category win rate it saw,
--      the sample size behind it, the confidence-adjusted estimate, the expected
--      recovery, and whether it was still in cold-start (too little data to lean
--      on). Frozen at generation time on purpose: it is the evidence for why the
--      packet was routed the way it was, and it is what later lets the flywheel
--      measure ITSELF -- did packets generated under a strong-signal read
--      actually win more often than the cold-start ones? That question can only
--      be answered if each packet remembers what the model believed when it was
--      built, not what the model believes now.
--
--   2. a partial index on resolved outcomes, so the live aggregation over a
--      tenant's answered appeals stays cheap as the history grows.
--
-- SCOPE -- deliberately tenant-scoped. Every estimate in this release is built
-- ONLY from the tenant's own recorded outcomes. A cross-tenant "network" model,
-- where one client's appeal history sharpens another client's estimates, is the
-- stronger moat but is a CONTRACTUAL decision, not a schema one: pooling one
-- covered entity's data to benefit another must be permitted by the governing
-- BAAs and business terms before any code does it. Nothing here pools across
-- tenants, and the application layer computes every figure under the tenant's
-- own RLS context. Network mode, if it is ever turned on, is a separate,
-- explicitly gated change made against that legal backdrop -- not implied by
-- this migration.
-- ============================================================================

BEGIN;

ALTER TABLE appeal_packet
  ADD COLUMN intelligence jsonb;

COMMENT ON COLUMN appeal_packet.intelligence IS
  'Snapshot of the payer-outcome flywheel''s read at generation time for this '
  'packet''s (payer, letter_category, appeal_type): the win rate observed, the '
  'sample size behind it, the confidence-adjusted estimate, expected recovery, '
  'and whether the estimate was still in cold-start. Frozen as the audit record '
  'of why the packet was routed as it was, and as the basis for the flywheel to '
  'later measure its own lift. NULL when the intelligence layer did not run '
  '(e.g. packets generated before this feature). Computed only from the '
  'tenant''s own outcomes -- never pooled across tenants.';

-- The flywheel aggregation reads only packets a payer has actually answered
-- (outcome IS NOT NULL). A partial index keeps that scan proportional to the
-- resolved set rather than to every draft/ready/submitted packet a tenant holds.
CREATE INDEX idx_packet_resolved_outcome
  ON appeal_packet (tenant_id, case_id)
  WHERE outcome IS NOT NULL AND deleted_at IS NULL;

COMMIT;
