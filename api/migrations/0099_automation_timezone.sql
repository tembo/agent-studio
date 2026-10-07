-- Preserve existing UTC schedules; browser-created schedules save their IANA zone.
ALTER TABLE automation
    ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
