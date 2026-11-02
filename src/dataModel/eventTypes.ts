import AjvDraft04 from 'ajv-draft-04';
import type { ValidateFunction } from 'ajv';
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

/**
 * Validates one event's type and content against the pack.
 * Returns the problems found, empty when the event can be written.
 */
export function validateEvent (pack: DataModelPack, type: string, content: unknown): string[] {
  const schema = contentSchema(pack, type);
  if (!schema) {
    return [`Unknown event type "${type}": not in the HDS data model (${packLabel(pack)}). Use the eventType from get_item.`];
  }
  if (schema.attachmentRequired === true) {
    return [`Event type "${type}" needs an attachment, which this MCP cannot upload yet.`];
  }
  const validate = compiled.get(type) ?? ajv.compile(schema);
  compiled.set(type, validate);
  if (validate(content === undefined ? null : content)) return [];
  return (validate.errors ?? []).map((e) =>
    `content${e.instancePath || ''} ${e.message ?? 'is invalid'}` +
    (e.params && Object.keys(e.params).length > 0 ? ` (${JSON.stringify(e.params)})` : '')
  );
}

export function packLabel (pack: DataModelPack): string {
  return pack.version ? `data-model ${pack.version}` : 'data-model (version unknown)';
}
