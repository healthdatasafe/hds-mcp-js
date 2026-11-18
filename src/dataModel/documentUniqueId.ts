// A document's identifier in the one spelling `file/xds-v1` `uniqueId` stores (data-model DOCUMENTS.md, "A document
// already held"), and its `clientData.hdsDocumentUniqueId` key. A port of hds-lib 2.55.1 `normalizeDocumentUniqueId`
// and `documentUniqueIdKey` (ts/HDSModel/encounters.ts): this server does not depend on hds-lib. Keep the two in step.

export const IDENTIFIER_SYSTEM_URI = 'urn:ietf:rfc:3986';
export const DOCUMENT_UNIQUE_ID_KEY = 'hdsDocumentUniqueId';

export interface DocumentUniqueId { system: string; value: string }

const OID_RE = /^[0-2](\.(0|[1-9][0-9]*))+$/;
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
// The schema's value pattern is `^\S(.*\S)?$`, and `.` matches no line terminator (U+2028 and U+2029 included).
const LINE_BREAK_RE = /[\n\r\u2028\u2029]/;
/** As the schema: a URI scheme, then no space and no `|` (the key separator). */
const SYSTEM_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s|]+$/;

function oidOrUuidUri (text: string): string | null {
  const m = /^urn:(oid|uuid):(.*)$/i.exec(text);
  const kind = m ? m[1].toLowerCase() : null;
  const body = m ? m[2] : text;
  if (kind !== 'uuid' && OID_RE.test(body)) return 'urn:oid:' + body;
  if (kind !== 'oid' && UUID_RE.test(body)) return 'urn:uuid:' + body.toLowerCase();
  return null;
}

/**
 * A string is an XDS `uniqueId` (an OID or a UUID, bare or prefixed, any case); an object is a FHIR
 * `masterIdentifier` (`system` + `value`). Null for what is not stored: `<root>^<extension>`, a `urn:oid:` system,
 * no system, a blank value.
 */
export function normalizeDocumentUniqueId (id: unknown): DocumentUniqueId | null {
  if (typeof id === 'string') {
    const value = oidOrUuidUri(id.trim());
    return value == null ? null : { system: IDENTIFIER_SYSTEM_URI, value };
  }
  if (id == null || typeof id !== 'object' || Array.isArray(id)) return null;
  const { system: rawSystem, value: rawValue } = id as Record<string, unknown>;
  if (typeof rawSystem !== 'string' || typeof rawValue !== 'string') return null;
  const system = rawSystem.trim();
  const value = rawValue.trim();
  if (value === '' || LINE_BREAK_RE.test(value)) return null;
  if (system.toLowerCase() === IDENTIFIER_SYSTEM_URI) {
    const uri = oidOrUuidUri(value);
    return uri == null ? null : { system: IDENTIFIER_SYSTEM_URI, value: uri };
  }
  if (/^urn:oid:/i.test(system) || !SYSTEM_RE.test(system)) return null;
  return { system, value };
}

/** `<system>|<value>`, the `clientData.hdsDocumentUniqueId` a document is looked up by */
export function documentUniqueIdKey (id: DocumentUniqueId): string {
  return id.system + '|' + id.value;
}
