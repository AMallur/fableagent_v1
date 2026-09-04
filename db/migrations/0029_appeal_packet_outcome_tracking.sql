-- ============================================================================
-- 0029_appeal_packet_outcome_tracking.sql
--
-- Two columns this repo does not yet have, and both are missing for the same
-- reason: nothing has captured the shape of data a future payer-response
-- model would need, because no real appeal has gone out yet to need it.
--
--   LETTER_CATEGORY. appeals/letter.ts already picks a category
--   (medical_necessity, authorization, bundling, timely_filing, duplicate,
--   coding, underpayment, general) to select which argument template to use
--   for a packet's letter -- see letterCategory() in appeals/letter.ts. That
--   value was computed, used to render the letter, and discarded; nothing
--   persisted which argument a given packet actually made. Re-deriving it
--   later from recovery_case.denial_category is not equivalent: that mapping
--   can change as letter.ts evolves, and a historical record has to freeze
--   what was actually sent, not what current logic would send today.
--
--   OUTCOME. appeal_packet already tracks packet_status (draft/ready/
--   submitted/acknowledged) -- transmission lifecycle -- and recovery_case
--   already tracks status (open/.../won/lost) -- the case's final
--   disposition. Neither answers "what happened to this specific appeal,
--   at this specific level" when a case escalates through more than one
--   packet (first_level denied, second_level overturned): only the last
--   word survives on the case, and the level-by-level signal a
--   payer-behavior model would need is not recorded anywhere.
--
-- This migration only adds columns and leaves them unset. It does not wire
-- anything to set them -- that is a workflow decision (which packet a given
-- payment or denial actually resolves, when a case has more than one) that
-- belongs in the application layer, made deliberately, not implied by a
-- migration.
-- ============================================================================

BEGIN;

ALTER TABLE appeal_packet
  ADD COLUMN letter_category text,
  ADD COLUMN outcome text
    CHECK (outcome IS NULL OR outcome IN ('pending', 'overturned', 'upheld', 'partial')),
  ADD COLUMN outcome_amount numeric(12,2),
  ADD COLUMN outcome_recorded_at timestamptz,
  ADD COLUMN outcome_recorded_by uuid REFERENCES app_user (user_id);

COMMENT ON COLUMN appeal_packet.letter_category IS
  'The argument category (see LetterCategory in appeals/types.ts) actually '
  'used for this packet''s letter, frozen at generation time. Historical '
  'record of what was sent, not a value to re-derive from the case''s '
  'current denial_category.';

COMMENT ON COLUMN appeal_packet.outcome IS
  'This packet''s own adjudication result, distinct from recovery_case.status: '
  'a case can carry several packets across appeal levels, and each level''s '
  'outcome is a separate data point a payer-response model needs. NULL until '
  'someone records it -- there is deliberately no default of ''pending'' so '
  'that "not yet recorded" and "known pending" stay distinguishable.';

COMMENT ON COLUMN appeal_packet.outcome_amount IS
  'Dollar amount actually recovered attributable to this packet, if known. '
  'May differ from recovery_case.recovery_opportunity, which is the '
  'detection engine''s estimate, not a confirmed result.';

COMMIT;
