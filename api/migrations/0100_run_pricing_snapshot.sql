-- Historical costs retain their original estimate; NULL marks a legacy basis.
ALTER TABLE run ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB DEFAULT NULL;
