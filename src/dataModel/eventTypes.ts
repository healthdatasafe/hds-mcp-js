import AjvDraft04 from 'ajv-draft-04';
import type { ValidateFunction } from 'ajv';
import { en } from './pack.ts';
import type { DataModelPack, ItemDef } from './pack.ts';

// Same options as the data-model tests use for "draft-04 (the cores)".
// CommonJS package: under nodenext the default import is module.exports, whose .default is the class.
const Ajv = AjvDraft04.default;
const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false, logger: false });
const compiled = new Map<string, ValidateFunction>();

/**
 * The eventTypes an item accepts: its `eventType`, or, for items with a unit
 * choice, every `variations.eventType.options[].value`.
 */
export function itemEventTypes (item: ItemDef): string[] {
  if (typeof item.eventType === 'string') return [item.eventType];
  const options = item.variations?.eventType?.options;
  if (!Array.isArray(options)) return [];
  return options.map((o) => o.value).filter((v): v is string => typeof v === 'string');
}

export function contentSchema (pack: DataModelPack, type: string): Record<string, any> | undefined {
  return pack.eventTypes?.types?.[type];
}

export interface ValidateOptions {
  /** The local (stdio) MCP, whose attach_file adds the file of an attachment type after the event is written. */
  attachFile?: boolean;
  /** import_batch: an attachment type is written one event at a time (create_event, then attach_file). */
  batch?: boolean;
  /** The event's streams: with them, a value of an item with options must be one of its options. */
  streamIds?: string[];
}

/**
 * The item an event is written to, as hds-lib's `itemsDefs.forEvent` finds it: the first of its streams that carries an
 * item of this eventType (the active item when a deprecated alias shares the pair). Null when none does.
 */
export function itemForEvent (pack: DataModelPack, streamIds: string[], type: string): { key: string; item: ItemDef } | null {
  for (const streamId of streamIds) {
    let found: { key: string; item: ItemDef } | null = null;
    for (const [key, item] of Object.entries(pack.items)) {
      if (item.streamId !== streamId || !itemEventTypes(item).includes(type)) continue;
      if (found == null || (found.item.deprecated === true && item.deprecated !== true)) found = { key, item };
    }
    if (found != null) return found;
  }
  return null;
}

/**
 * For an item with options (select, multi-select), the values of `content` that are not one of them: the renderers and
 * the FHIR export know the options only, so another value the eventType allows is not shown or exported.
 * Null when the event's item has no options, or every value is one of them.
 */
export function optionProblem (pack: DataModelPack, streamIds: string[], type: string, content: unknown): { key: string; values: unknown[]; allowed: string } | null {
  const found = itemForEvent(pack, streamIds, type);
  const options = found?.item.options;
  if (found == null || !Array.isArray(options) || options.length === 0) return null;
  const allowedValues = options.map((o: any) => o?.value);
  const given = found.item.type === 'multi-select' && Array.isArray(content) ? content : [content];
  const values = given.filter((v) => !allowedValues.some((a) => a === v));
  if (values.length === 0) return null;
  const allowed = options.map((o: any) => `${JSON.stringify(o?.value)} (${en(o?.label)})`).join(', ');
  return { key: found.key, values, allowed };
}

/**
 * Validates one event's type and content against the pack.
 * Returns the problems found, empty when the event can be written.
 */
export function validateEvent (pack: DataModelPack, type: string, content: unknown, { attachFile = false, batch = false, streamIds }: ValidateOptions = {}): string[] {
  const schema = contentSchema(pack, type);
  if (!schema) {
    return [`Unknown event type "${type}": not in the HDS data model (${packLabel(pack)}). Use the eventType from get_item.`];
  }
  if (schema.attachmentRequired === true) {
    if (!attachFile) return [`Event type "${type}" needs an attachment, which this MCP cannot upload yet.`];
    if (batch) return [`Event type "${type}" needs an attachment: create it with create_event, then add its file with attach_file.`];
  }
  const validate = compiled.get(type) ?? ajv.compile(schema);
  compiled.set(type, validate);
  if (validate(content === undefined ? null : content)) {
    const notOption = streamIds != null ? optionProblem(pack, streamIds, type, content) : null;
    if (notOption == null) return [];
    return [`content ${notOption.values.map((v) => JSON.stringify(v)).join(', ')} is not an option of item "${notOption.key}". ` +
      `Allowed values: ${notOption.allowed}`];
  }
  return (validate.errors ?? []).map((e) =>
    `content${e.instancePath || ''} ${e.message ?? 'is invalid'}` +
    (e.params && Object.keys(e.params).length > 0 ? ` (${JSON.stringify(e.params)})` : '')
  );
}

/**
 * The local import kit's check (plan 130): the same schema validation, as field paths and schema keywords only, so
 * no value of the person's record is echoed (ajv `params` can hold one: an enum's allowed values, a pattern, a limit).
 */
export function contentErrors (pack: DataModelPack, type: string, content: unknown): Array<{ path: string; keyword: string }> | null {
  const schema = contentSchema(pack, type);
  if (!schema) return null;
  const validate = compiled.get(type) ?? ajv.compile(schema);
  compiled.set(type, validate);
  if (validate(content === undefined ? null : content)) return [];
  return (validate.errors ?? []).map((e) => ({ path: e.instancePath || '/', keyword: e.keyword }));
}

export function packLabel (pack: DataModelPack): string {
  return pack.version ? `data-model ${pack.version}` : 'data-model (version unknown)';
}
