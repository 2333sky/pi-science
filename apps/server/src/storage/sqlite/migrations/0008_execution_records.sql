CREATE TABLE execution_records (
  execution_id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX execution_records_workspace_created_idx
  ON execution_records(workspace_path, created_at DESC);

CREATE TRIGGER jobs_update_execution_record
AFTER UPDATE OF status, started_at, ended_at, stdout, stderr, return_code ON jobs
WHEN NEW.execution_id IS NOT NULL
BEGIN
  UPDATE execution_records
  SET record_json = CASE WHEN NEW.ended_at IS NULL THEN
        json_set(
          record_json,
          '$.status', NEW.status,
          '$.started_at', COALESCE(
            CASE WHEN NEW.started_at IS NULL THEN NULL
                 ELSE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at / 1000.0, 'unixepoch') END,
            json_extract(record_json, '$.started_at')
          ),
          '$.producer', 'node-job-coordinator'
        )
      ELSE
        json_set(
          record_json,
          '$.status', NEW.status,
          '$.started_at', COALESCE(
            CASE WHEN NEW.started_at IS NULL THEN NULL
                 ELSE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.started_at / 1000.0, 'unixepoch') END,
            json_extract(record_json, '$.started_at')
          ),
          '$.ended_at', strftime('%Y-%m-%dT%H:%M:%fZ', NEW.ended_at / 1000.0, 'unixepoch'),
          '$.producer', 'node-job-coordinator',
          '$.result', json_object(
            'exit_code', NEW.return_code,
            'stdout_preview', substr(NEW.stdout, -64000),
            'stderr_preview', substr(NEW.stderr, -64000)
          )
        )
      END,
      updated_at = NEW.updated_at
  WHERE execution_id = NEW.execution_id;
END;
