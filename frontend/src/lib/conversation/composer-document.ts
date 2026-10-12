import type { WorkspaceReference } from "../files/file-references";
import type { SubagentMention } from "./subagent-mentions";

/** Text is readable; entities bind ranges to workspace objects or agents.
 * All offsets are UTF-16 positions, matching textarea selectionStart/End. */
export type ComposerEntity =
  | (SubagentMention & { kind: "mention" })
  | { id: string; kind: "reference"; start: number; end: number; reference: WorkspaceReference };

export interface ComposerDocument {
  value: string;
  entities: ComposerEntity[];
}

export function entityToken(entity: ComposerEntity): string {
  return entity.kind === "mention" ? `@${entity.name}` : `@${entity.reference.path}`;
}

/** Fail open for malformed metadata: never block typing or rebind plain text. */
export function validComposerEntities(value: string, entities: readonly ComposerEntity[]): ComposerEntity[] {
  const result: ComposerEntity[] = [];
  let end = 0;
  for (const entity of [...entities].sort((a, b) => a.start - b.start)) {
    if (!Number.isInteger(entity.start) || !Number.isInteger(entity.end)
      || entity.start < end || entity.start < 0 || entity.start >= entity.end || entity.end > value.length
      || value.slice(entity.start, entity.end) !== entityToken(entity)) continue;
    result.push(entity);
    end = entity.end;
  }
  return result;
}

export interface ComposerEditIntent {
  value: string;
  entities: readonly ComposerEntity[];
  selectionStart: number;
  selectionEnd: number;
  inputType: string;
}

function editRange(intent: ComposerEditIntent, nextValue: string) {
  let { selectionStart: start, selectionEnd: end } = intent;
  const removed = intent.value.length - nextValue.length;
  if (start === end && removed > 0 && intent.inputType.startsWith("delete")) {
    if (intent.inputType.endsWith("Backward")) start = Math.max(0, start - removed);
    else if (intent.inputType.endsWith("Forward")) end = Math.min(intent.value.length, end + removed);
    else return null;
  }
  if (start < 0 || end < start || end > intent.value.length) return null;
  const prefix = intent.value.slice(0, start);
  const suffix = intent.value.slice(end);
  if (!nextValue.startsWith(prefix) || !nextValue.endsWith(suffix)
    || nextValue.length < prefix.length + suffix.length) return null;
  return { start, end, inserted: nextValue.slice(prefix.length, nextValue.length - suffix.length) };
}

export function entityIntersectsEdit(entity: ComposerEntity, start: number, oldEnd: number): boolean {
  return start === oldEnd
    ? entity.start < start && start < entity.end
    : start < entity.end && oldEnd > entity.start;
}

export function applyComposerEdit(document: ComposerDocument, intent: ComposerEditIntent, nextValue: string): ComposerDocument & { caret: number } {
  if (intent.value !== document.value) return { value: nextValue, entities: [], caret: nextValue.length };
  const entities = validComposerEntities(intent.value, intent.entities);
  const range = editRange(intent, nextValue);
  if (!range) return { value: nextValue, entities: [], caret: nextValue.length };
  const { start, end, inserted } = range;
  const affected = entities.filter((entity) => entityIntersectsEdit(entity, start, end));
  if (affected.length > 0) {
    const expandedStart = Math.min(start, ...affected.map((entity) => entity.start));
    const expandedEnd = Math.max(end, ...affected.map((entity) => entity.end));
    const value = document.value.slice(0, expandedStart) + inserted + document.value.slice(expandedEnd);
    const delta = inserted.length - (expandedEnd - expandedStart);
    const remaining = entities.filter((entity) => !affected.includes(entity))
      .map((entity) => entity.start >= expandedEnd
        ? { ...entity, start: entity.start + delta, end: entity.end + delta } : entity);
    return { value, entities: validComposerEntities(value, remaining), caret: expandedStart + inserted.length };
  }
  const delta = inserted.length - (end - start);
  const shifted = entities.map((entity) => entity.start >= end
    ? { ...entity, start: entity.start + delta, end: entity.end + delta } : entity);
  return { value: nextValue, entities: validComposerEntities(nextValue, shifted), caret: start + inserted.length };
}

/** Without the selection and input type a changed string cannot identify which repeated token was edited. */
export function updateComposerDocument(document: ComposerDocument, nextValue: string): ComposerDocument & { caret: number } {
  if (nextValue === document.value) return { ...document, entities: validComposerEntities(document.value, document.entities), caret: nextValue.length };
  return { value: nextValue, entities: [], caret: nextValue.length };
}

export function inlineWorkspaceReferences(entities: readonly ComposerEntity[]): WorkspaceReference[] {
  const references = entities.flatMap((entity) => entity.kind === "reference" ? [entity.reference] : []);
  return references.filter((reference, index) =>
    references.findIndex((other) => other.cwd === reference.cwd && other.path === reference.path) === index);
}

