CREATE INDEX execution_records_workspace_session_created_idx
  ON execution_records(
    workspace_path,
    json_extract(record_json, '$.correlation.session_id'),
    created_at DESC,
    execution_id ASC
  );
