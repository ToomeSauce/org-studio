ALTER TABLE org_studio_roadmap_versions
ADD COLUMN IF NOT EXISTS version_type TEXT DEFAULT 'outcome'
CHECK (version_type IN ('outcome', 'foundation', 'chore'));
