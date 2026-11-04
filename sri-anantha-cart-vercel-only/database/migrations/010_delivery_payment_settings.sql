BEGIN;

ALTER TABLE delivery_zones
  ADD COLUMN IF NOT EXISTS cod_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS cod_limit_paise INTEGER NOT NULL DEFAULT 0;
ALTER TABLE delivery_zones DROP CONSTRAINT IF EXISTS delivery_zones_cod_limit_nonnegative;
ALTER TABLE delivery_zones ADD CONSTRAINT delivery_zones_cod_limit_nonnegative CHECK (cod_limit_paise >= 0);

ALTER TABLE delivery_time_slots
  ADD COLUMN IF NOT EXISTS slot_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_time_slots_zone_name_unique
  ON delivery_time_slots (COALESCE(zone_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

COMMIT;
