CREATE TABLE IF NOT EXISTS calendar_sync (
  user_email TEXT NOT NULL,
  task_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  meeting_status TEXT NOT NULL DEFAULT '',
  synced_at TEXT NOT NULL,
  PRIMARY KEY (user_email, task_id),
  FOREIGN KEY (user_email) REFERENCES users(email) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS calendar_sync_user_idx ON calendar_sync(user_email);

-- La firma queda vacía a propósito: el próximo guardado la trata como "cambiada"
-- y hace un solo PATCH de reconciliación por tarea, sin recrear ningún evento.
INSERT OR IGNORE INTO calendar_sync (user_email, task_id, event_id, signature, meeting_status, synced_at)
SELECT u.email, json_extract(t.value, '$.id'), json_extract(t.value, '$.calendarEventId'),
  '', COALESCE(json_extract(t.value, '$.meetingStatus'), ''), u.updated_at
FROM users u, json_each(u.state_json, '$.tasks') t
WHERE u.state_json IS NOT NULL
  AND json_extract(t.value, '$.calendarEventId') IS NOT NULL
  AND json_extract(t.value, '$.calendarEventId') != '';
