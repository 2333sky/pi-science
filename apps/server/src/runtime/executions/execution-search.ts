import { executionRecordSchema, type ExecutionRecord } from "@pi-science/contracts";

export function parseExecutionRecord(json: string): ExecutionRecord | null {
  const result = executionRecordSchema.safeParse(JSON.parse(json));
  return result.success ? result.data : null;
}

export function executionMatchesSearch(record: ExecutionRecord, needle: string): boolean {
  return JSON.stringify([
    record.execution_id,
    record.kind,
    record.surface,
    record.status,
    record.producer,
    record.correlation,
    record.request,
    record.result,
    record.files,
    record.artifacts,
  ])
    .toLocaleLowerCase()
    .includes(needle);
}
