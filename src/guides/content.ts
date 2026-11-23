// Import guides returned by get_import_guide({ topic }). Audience: an AI model helping a
// non-technical patient upload their medical history. Every rule comes from llms-full.txt
// (§3, §5f, §6) or the data-model documentation, which stay the source of truth.

export const GUIDE_TOPICS = ['overview', 'lab-report', 'letter', 'photo', 'spreadsheet', 'app-export', 'missing-item'] as const;

export type GuideTopic = typeof GUIDE_TOPICS[number];

export const GUIDES: Record<GuideTopic, string> = {
  overview: `# Importing a patient's medical history into Health Data Safe (HDS)

Plain words, one step at a time, wait for the patient's go between steps. Per-source guides,
get_import_guide({ topic }): lab-report, letter, photo, spreadsheet, app-export, missing-item.
Reference: https://agents.datasafe.dev/llms-full.txt (§3 items, §5f imports, §6 privacy).

## 1. Privacy first: tell the patient, and wait for their go
- Everything you read (each page, scan, photo, value, get_events result) is sent to your model
  provider. Nothing in HDS or in this MCP can prevent that.
- Their HDS account keeps what you write. Apps they grant later see the granted parts, including
  free text, provider names and the import references (sourceKey, hdsTimeText).
- A provider that does not train on their data, or a local model, is the safer choice.
- They choose what gets imported and can stop at any point.
- Codes are looked up with search_items (local MCP: on this computer; remote connector: on the
  HDS server) and search_dataset (the HDS datasets service). Never search a test, diagnosis or
  drug name from their records on the web or on a terminology site or server (tx.fhir.org,
  loinc.org, a SNOMED browser): that sends it away. A printed code may be checked there by the
  code alone; it still names the test. Data-model TERMINOLOGY.md.
Say it again before the first read of a production (real) account.

## 1b. Demo or production: say which, and suggest a trial on demo
get_connection() tells which platform this session uses. Production holds their real record;
demo is a test platform that can be wiped. To see how it works first, suggest a throwaway demo
account (https://demo-account.datasafe.dev/register, made-up details) and a trial with made-up
values, never their real records; then the real import on production.

## 2. Inventory
Ask what they have (lab reports, letters, photos of documents, spreadsheets, app exports) and
which to import. One source type at a time. They attach files to the chat and you read them:
this MCP cannot read their files. Original files: only the local MCP can store them (2b); the
remote connector cannot: say so, store the values you extract, they keep the files.

## 2b. Original documents (local MCP only)
A PDF, JPEG or PNG of up to 20 MB, one file per document, only those the patient asks to keep:
- ensure_streams({ items: ["document"] }); then create_event on stream "documents", type
  file/xds-v1, content from get_event_type (class, type, title, language), with a sourceKey.
  class and type: pick the kind with list_document_kinds, then copy its Codings from
  list_document_kinds({ key }) unchanged; never make up a code. Event time per the kind's timeBasis:
  the date of the care reported, or the date it was written; never a fax, scan or upload date.
- A document with its own identifier (an XDS uniqueId from a record export, a FHIR
  masterIdentifier): first get_events({ documentUniqueId, state: "all" }). Found: it is already held;
  fill only what is missing, never write it twice. Not found: create it with content.uniqueId and
  clientData.hdsDocumentUniqueId = "<system>|<value>". An OID or a UUID is spelled system
  "urn:ietf:rfc:3986", value "urn:oid:<oid>" or "urn:uuid:<uuid in lower case>"; an XDS
  "<root>^<extension>" identifier is not stored (data-model DOCUMENTS.md, "A document already held").
- Ask the patient for the file's full path on their computer, then
  attach_file({ eventId, path }). Only the file name is sent; the file is not shown to you.
- Read it back with get_events. A document event without its file shows as a failed import:
  if attach_file is refused, fix it and attach again, or delete the event.

## 3. Access
- Local MCP: connect({ roots, importName }). roots: only the root streams the import writes
  (list_model_streams). importName: the <tool> part of every sourceKey. Tell the patient which
  kinds of data and which level before sign-in, then ensure_streams({ items }) before writing.
  Production writes: connect({ host: "prod", enableWrites: true, ... }), only if they asked.
- Remote connector: no ensure_streams. The patient signed in through the connector; their client
  asks them for write consent on each data root at the first write. Raw address (.../raw, no
  client ID): connect() gives a sign-in link for them to open, then connect_status(), then
  ensure_streams({ items }) before writing.

## 4. Item first
For each kind of data: search_items, then get_item; use its streamId, eventType and content
schema. Never invent a type or a stream. On items with unit variations the printed unit picks the
eventType; a missing or ambiguous unit: ask. No item fits: see missing-item.

## 5. Provenance on every event
- clientData.sourceKey = "<tool>:<kind>:<id>", e.g. "healthfiles:lab:2024-03-12-ferritin".
  <tool>: one stable lowercase name, no ":". <id>: the record's identity in the source, the same
  on every run (never an import date or a counter). One event per key.
- No names, insurance or national numbers in the key: every reader of the event sees it.
- Sources first: a provider or a visit is written before the events that cite it
  (clientData.related.<eventId>: true). import_batch returns ids in input order for that.

## 6. Dates
time = when the fact belongs on the patient's timeline, as the document states it (the sample
date of a lab value, the onset of a condition), not when the file was made or sent. Known only to
the month or year: start of the period at 12:00 UTC, clientData.hdsTimePrecision "month", "year"
or "approx", hdsTimeText as written; never a duration. Before 1970: negative time.

## 7. Check, show, write, read back
Show the patient a plain summary of each batch (what, value, unit, date) and wait for their go.
import_batch (1-500 events) checks every content against its schema first: one bad event refuses
the whole batch and nothing is written; fix it and send again. Then read back with
get_events({ sourceKeyPrefix: "<tool>:" }) (page with limit + skip) and say what is stored.

## 8. Re-runs and undo
get_events({ sourceKeyPrefix, state: "all" }), match by sourceKey: new key = write it; changed
record = update_event (clientData is merged key by key; null removes a key); trashed = leave it, the
patient removed it. Undo: delete_events({ sourceKeyPrefix }) lists what would go; call again
with confirm: true only after the patient agrees.

## 9. A whole archive: the import package (when import_inspect is among your tools)
More than a few dozen values, or several documents: do not send them through tool calls. Write a
package folder on the patient's computer and let the import tools write it:
- manifest.json: { "format": "hds-import-package/1", "importName": "<a-z0-9->", "tool": "<sourceKey
  prefix>" }. events.jsonl: one event per line: sourceKey "<tool>:<kind>:<id>", itemKey (or
  streamIds + type), content, time (seconds, required), optional duration, description, clientData
  (never sourceKey or related: the kit sets them), relatedKeys, attachment "files/<name>" (a
  document's PDF/JPEG/PNG), evidence { file, page } (the source page, for the review only).
  Where an event id of the package is expected (supersedes, authors[].eventId, encounterId), write
  { "$ref": "<sourceKey>" }.
- import_inspect: fix every blocking problem (line numbers) and inspect again. It returns the roots
  and importName for connect: tell the patient those kinds of data before signing in.
- import_review: the page opens in their browser; they check the values there, not in the chat.
- import_write with confirm: true only after their go; follow import_status; then import_verify.
  Running it again is safe (resumes, never duplicates, leaves what they deleted).
- import_cleanup at the end; the package folder itself is a copy of their records: tell them.
`,

  'lab-report': `# Lab reports (PDF or scan)

You read the report; the MCP cannot. Rules from data-model BLOOD-CHEMISTRY.md:
https://github.com/healthdatasafe/data-model/blob/main/documentation/BLOOD-CHEMISTRY.md
- One event per result. Find the item: search_items with the test name, or with the LOINC code
  when the report prints one; then get_item. The specimen is part of the item (serum and urine
  are different items), and so is fasting (fasting and untimed glucose or insulin).
- Value as printed, never converted. The printed unit picks the item's eventType variation (an
  option labelled ng/mL stores on ug/L, same number). No unit, or unclear: ask the patient.
- A share of a whole (ratio/proportion: HbA1c, hematocrit, CBC %) is stored as a fraction, 41 %
  as 0.41. A ratio to a reference (Quick %, ratio/percent) is stored as printed. get_item tells.
- Printed range: clientData.hdsRefRange { lowerLimit, upperLimit, text }, limits on the stored
  scale (36 - 46 % is 0.36 and 0.46), text exactly as printed. "< 5.0" is upperLimit 5 only;
  "negative", or a range printed in another unit than the value, is text only.
- Printed flag: clientData.hdsFlag exactly as printed (H, L, *, ↑). hdsInterpretation only by
  normalising a printed flag: H or ↑ → H, L or ↓ → L, critical → HH or LL, * or ! → A, a printed
  "normal" → N; an ambiguous flag (+) stays in hdsFlag alone. No flag printed: no
  hdsInterpretation. Never compute a verdict from the value and the range.
- A limit instead of a figure ("< 1.5"): content 1.5, clientData.hdsComparator "<" (<, <=, >, >=)
  and description "< 1.5 ng/mL". A limit with no figure ("< LOQ"): coded fallback, valueText.
- A printed specimen detail ("plasma hep.") goes in description.
- Coded fallback, when the analyte has no item or its item lacks the printed unit:
  lab-result/coded-v1 on body-blood-coded, body-urine-coded or body-csf-coded (get_item; shape
  from get_event_type). content: analyte { label: { en }, codes: [{ system: "http://loinc.org",
  code }] }, value, unit (UCUM code: umol/L, 10*9/L, {copies}/mL), unitText as printed,
  comparator, valueText (negative, 1:160), notes. Range and flag as above, limits in unit.
  Never for an analyte an item owns (search its LOINC code first). Only a LOINC code the report
  prints, one from the verified table below, or one you verified; never a guessed one. To check
  a code, query a terminology server with the code, never with the test name. A result you
  cannot code: keep it aside and tell the patient (missing-item).
- Verified codes for the coded fallback (data-model BLOOD-CHEMISTRY.md § Verified codes for
  frequent coded results, LOINC 2.83). Value and unit as printed: a % stays 62.5 with unit "%".
  Indirect (unconjugated, "libre") bilirubin: mg/L or mg/dL 1971-1, umol/L 14630-8.
  Prealbumin (transthyretin): g/L, mg/L or mg/dL 14338-8, umol/L 77192-3.
  Serum protein electrophoresis, % then g/L: albumin 13980-8 / 2862-1; alpha-1 13978-2 /
  2865-4; alpha-2 13981-6 / 2868-8; beta (one line) 13982-4 / 2871-2; beta-1 32732-0 /
  32730-4; beta-2 32733-8 / 32731-2; gamma 13983-2 / 2874-6. Not the albumin or globulin
  items: those are chemistry assays.
  Albumin/globulin ratio, unit {ratio}: from the electrophoresis 44429-9, else 1759-0.
  Lymphocyte subsets, % of lymphocytes (unit %) then count (/mm3 or /uL, unit /uL): CD3
  8124-0 / 8122-4; CD4 8123-2 / 24467-3; CD8 8101-8 / 14135-8. CD4/CD8 ratio 54218-3, {ratio}.
  A % of CD3 or of leukocytes is not these codes. A ratio is unit {ratio}, never 1.
  A ratio or an indirect bilirubin only when the lab printed it, never computed.
- Counts printed per mm3 are per uL (1 mm3 = 1 uL): a full count (6 500/mm3) goes to the
  "/μL (/mm³)" option of the item; a scaled count (6,5 10³/mm³, 4,50 10⁶/mm³) is the number of the
  item's first option (10⁹/L, 10¹²/L), never the /μL one.
- Time: when the sample was taken (its date, and time of day when printed), not the report date.
  Date only: 12:00 UTC that day, clientData.hdsTimePrecision "day".
- sourceKey per result, from the sample date and the analyte, e.g.
  "healthfiles:lab:2024-03-12-ferritin".
- The report itself: the local MCP stores it as a document (overview 2b), if the patient asks;
  the remote connector cannot store it: say so, the patient keeps it.
`,

  letter: `# Letters and reports (discharge letters, consultation reports)

You read the letter; the MCP cannot. Store only what it states; ask the patient when unsure.
Confirm every item below with search_items / get_item before writing.
- Doctors and therapists: encounter-provider-person; clinics, hospitals, practices:
  encounter-provider-organization; name as printed. Before creating one, read existing ones
  (get_events, types provider/practitioner-v1 and provider/organization-v1, state "all") and
  reuse the one with the same GLN / ZSR (clientData.hdsGln, hdsZsr) or sourceKey. A trashed one
  is linked to, never updated.
- The visit or stay: encounter-visit (kind, reason; time = start; duration only when the end is
  known: an unknown end is no duration, never null). participants[].eventId and
  serviceProvider.eventId point at the providers.
- Diagnoses: condition-coded (time = onset, or the diagnosis date when that is all it says).
  content.status only when the letter states it: active, recurrence, relapse, inactive,
  remission or resolved; none stated, no status. A duration only when the letter dates the end
  (time + duration = when it stopped) and then status inactive, remission or resolved; no known
  end: no duration key at all, never 0 or null (an open condition is said by its status).
  Findings: finding-coded. Procedures: procedure-coded, else procedure-basic (name as printed).
  Treatments over time: treatment-coded, else treatment-basic. Each cites the visit with
  clientData.related.<visitId>: true.
- Allergies and intolerances: allergy-coded (content.allergen from the allergen dataset), else
  allergy-basic (name as printed). content.status is required: active, inactive or resolved as the
  letter states it; not stated: ask the patient, never default it. verificationStatus only when
  stated (unconfirmed or confirmed), never confirmed by default. A refuted or erroneous allergy
  is not written. time = onset;
  not known (the usual case): hdsTimePrecision "unknown", time the letter date. No duration.
  categories (food, medication, environment, biologic) only when stated, never an empty list;
  type (allergy, intolerance) and criticality (low, high, unable-to-assess) only when stated.
  Reactions: content.reactions [{ manifestations, severity: mild, moderate or severe, notes }];
  each manifestation from the manifestation dataset ({ label, codes } as returned), else { text }
  as printed (e.g. "hives"); a reaction needs at least one, and no reaction = no reactions key.
  lastOccurrence as YYYY, YYYY-MM or YYYY-MM-DD,
  never a full timestamp.
- "No known allergies" (NKA, NKDA, no known drug, food or environmental allergies):
  allergy-none-known, never an allergen. content.scope as written: all, medication (drug, NKDA),
  food or environment. time = the letter date, at its precision, never "unknown"; no duration.
  verificationStatus only when stated; notes optional; no status or other allergy field. Never in
  the same event as an allergen. A no-known animal, insect or latex allergy is not written (no
  narrower scope).
- Medications: medication-prescription-coded or medication-intake-coded; no coded match: a
  prescription goes to medication-prescription-basic (name as printed, optional posology), an
  intake to medication-intake-basic (name as printed). drug.label = the name as printed, a brand
  not translated; the regimen in intake (posology on a prescription): doseValue, doseUnit, route,
  frequency, asNeeded, note, and either timeOfDay (["08:00"]) or when (printed moments such as
  "breakfast", "after-meal"), never both; a planned course in bounds (duration + durationUnit, or
  start / end). An intake with a duration is a period of use (duration null = still running),
  without one it is a single dose. "Stopped because of side effects": stopReason on the closed
  period, or a prescription with status "stopped", statusChanged and stopReason. Never write
  status "skipped" on an intake yet (older patient apps count it as taken).
- Lab values printed in the letter: see lab-report.
Coded entries: list_datasources, then search_dataset({ datasource, query }) with condition,
finding, medication, procedure, treatment, allergen or manifestation. Copy the chosen entry
as search_dataset returns it, unchanged, into the coded property (content.condition,
content.drug, content.allergen, a reaction's manifestations, ...; shape from get_event_type). The query goes to the HDS datasets
service: tell the patient when it names their condition, medication or allergy. The lists are curated and incomplete: no match = tell the patient, use the
free-text item where one exists, never invent or edit a code.
Order, sources first: organization, practitioner, visit, then what cites them. Every event id put
in content is also set as clientData.related.<eventId>: true, in the same write.
Partial dates ("03.1999"): 1999-03-01 12:00 UTC, hdsTimePrecision "month", hdsTimeText "03.1999".
sourceKey per record, e.g. "<tool>:letter:<letter date>-<what>"; no names or ID numbers in it.
Names, reasons and notes are free text that every reader of the stream sees.
The letter itself: the local MCP stores it as a document (overview 2b) if the patient asks; the
remote connector cannot store it: say so, the patient keeps it.
Docs: ENCOUNTER.md, CONDITION.md, MEDICATION.md, ALLERGY.md, PARTIAL-DATES.md in
https://github.com/healthdatasafe/data-model/blob/main/documentation/
`,

  photo: `# Photos of documents

You read the photo with your own vision; the MCP cannot read it. Like any file, the photo is sent
to your model provider (overview, privacy).
- Read every value, unit, range, flag and date. Any digit, decimal point, unit or date you are not
  sure of (blur, glare, fold, cut-off edge, handwriting): ask the patient to confirm it, or to
  send a clearer photo. Never guess, never fill in what is usual.
- A unit cut off or unreadable: ask; a unit is never defaulted.
- Show the patient what you read (a short table: test or item, value, unit, date) and wait for
  their go before writing.
- Then follow the guide of the document: lab-report for results, letter for letters and
  reports, spreadsheet for a photographed table. Same item lookup, same clientData rules.
- Several photos of one document are one document: the sourceKey comes from the record (date,
  analyte), never from the photo, so a page sent twice does not duplicate values.
- The photo itself: the local MCP stores a JPEG or PNG as a document (overview 2b) if the patient
  asks; the remote connector cannot store it: say so, the patient keeps it.
`,

  spreadsheet: `# Spreadsheets (CSV, XLSX)

You read the file; the MCP cannot. First show the patient how you understood the columns.
- Map each column to an item: search_items, then get_item. A column no item fits: missing-item.
  Structured values never go into notes.
- Units: from the header or the cells ("Weight (kg)"); pick the item variation that matches.
  No unit, or an ambiguous one (is 158 kg or lb?): ask the patient, never default silently.
  Store values as written, never converted.
- One event per value: a row with a weight and a temperature is two events on two items.
- Dates: a date without a clock time is 12:00 UTC that day, clientData.hdsTimePrecision "day".
  A clock time needs its time zone to become a timestamp: if the file does not say, ask where it
  was recorded; with an exact time, hdsTimePrecision "minute" and clientData.hdsTimeZone (IANA
  name, e.g. "Europe/Zurich"). Month or year only: start of the period at 12:00 UTC, "month" or
  "year", hdsTimeText as written. A day/month order the file does not make clear (03/04): ask.
- sourceKey per value, from the row's own content (its date and the column), never from its
  position or the run, e.g. "<tool>:day:2026-03-02:weight". The same file again gives the same
  keys.
- Batches: show the patient a summary (number of rows, columns, date range, a few sample values)
  and wait for their go; import_batch takes at most 500 events per call; read back with
  get_events({ sourceKeyPrefix }). A very large file is better imported by a program on their own
  computer than through the chat (site-agents#36): tell the patient.
- An updated file run again: overview, re-runs (update by sourceKey, leave trashed events).
Docs: https://github.com/healthdatasafe/data-model/blob/main/documentation/PARTIAL-DATES.md
`,

  'app-export': `# App and record exports (Apple Health, FHIR bundle, C-CDA)

You read the export; the MCP cannot. Agree first with the patient on which kinds of data and
which period. A very large archive is better imported by a program on their own computer than
through the chat (site-agents#36).
- Codes first: search_items finds the item that owns a LOINC, SNOMED-CT, ICD-10 or ICF code
  (e.g. "29463-7"); use that item, not a coded result, when an item owns the code. Without a
  code, search by what was measured: search_items does not know Apple Health type names.
- Diagnoses, medications, procedures, allergies: search_dataset, as in letter. Never invent a code.
- Lab results with no item: lab-report (coded fallback).
- FHIR, per data-model FHIR-MAPPING.md § Import: an Observation matches an item by its code and
  category. Its valueQuantity UCUM unit picks the eventType and the value is stored as given; a
  unit the item does not offer is never converted (keep it aside, missing-item).
  Skip withdrawn records: Observation status entered-in-error or cancelled; Condition
  verificationStatus refuted or entered-in-error.
  Time: Observation effectiveDateTime, else effectivePeriod.start, else effectiveInstant;
  Condition onsetDateTime, else onsetPeriod.start, else recordedDate. A full dateTime is
  hdsTimePrecision "minute"; YYYY-MM-DD, YYYY-MM, YYYY give "day", "month", "year" at 12:00 UTC.
  A record with no readable date is not imported.
  Condition clinicalStatus (its condition-clinical code) is content.status. abatementDateTime
  gives the duration (abatement minus time, in seconds), only with status inactive, remission or
  resolved; no abatement: no duration key, never 0 or null.
  AllergyIntolerance (FHIR-MAPPING.md § AllergyIntolerance): code with an allergen-dataset match:
  allergy-coded, else allergy-basic by its text or display (a code outside SNOMED-CT and RxNorm is
  lost); a "no known allergy" record never goes on those two (below). Skip verificationStatus
  refuted or entered-in-error. clinicalStatus (active, inactive, resolved) is content.status;
  none: not imported. Time: onsetDateTime, else onsetPeriod.start, at their precision; onsetAge, onsetRange,
  onsetString or no onset: hdsTimePrecision "unknown", time the recordedDate (else now), the stated
  onset as text in notes ("Onset: at age 4 years"). recordedDate is never the onset. No duration.
  category, type, criticality, reaction severity as their codes; a value outside the set is left
  out. reaction[]: each manifestation coding matched in the manifestation dataset as { label, codes }
  as returned, else { text } (its text, else a display); severity; description as notes. lastOccurrence: its date part.
  "No known allergy" AllergyIntolerance (FHIR-MAPPING.md § No known allergy): allergy-none-known,
  content.scope from its code: SNOMED-CT 716186003 or the retired 160244002 all, 409137002
  medication, 429625007 food, 428607008 environment; IPS no-known-allergies,
  no-known-medication-allergies, no-known-food-allergies, no-known-environmental-allergies their
  scope; a code.text or display that is exactly NKDA or "no known drug allergy/allergies":
  medication; NKA, "no known allergy/allergies", "none known" (or the French or German): all.
  Time: recordedDate when not in the future, else now; never an onset, no duration.
  verificationStatus as the source has it, or none; no status. Not imported: animal 716220001,
  insect 428197003, latex 1003774007 or 716184000 (no narrower scope), no-allergy-info (no
  information is not "none"), a no-known code beside an allergen coding, clinicalStatus inactive
  or resolved, verificationStatus refuted or entered-in-error.
- C-CDA: use the LOINC, SNOMED-CT or ICD-10 codes it carries with search_items and
  search_dataset; same value, unit and date rules.
- sourceKey from the record's own identity, the same on every run. FHIR:
  "<tool>:<ResourceType>:<source>/<resource id>", <source> a stable opaque id you give the server
  (never its URL or name). Apple Health records carry no id: build it from the record (type,
  start and end dates). Device or source names ("Anna's iPhone") never go in a key.
- Duplicates: a re-run finds its own events by sourceKey (overview, re-runs). sourceKey is per
  importer, so values another app already wrote (a connector, an earlier import under another
  name) are not recognised: get_events on the item's stream for the same period, and ask the
  patient before writing what looks like the same values again.
- The export file itself cannot be stored: say so.
Docs: https://github.com/healthdatasafe/data-model/blob/main/documentation/FHIR-MAPPING.md
`,

  'missing-item': `# When no item fits

search_items found nothing for this kind of data. Try once more with other words, the French
label, or a code printed on the document. Still nothing:
1. Do not invent a type or a stream, and do not put structured values into notes: a note cannot
   be charted, compared or exported (llms-full.txt §3).
2. A lab result whose analyte has no item, or whose item lacks the printed unit, can go to the
   coded lab fallback (lab-result/coded-v1, see lab-report). The gap is still worth reporting.
   Not gaps, decided (data-model PROFILE.md § Not modelled): emergency contacts and a trusted
   person for health decisions (another person's contact details) are not stored; advance
   directives and organ donation are stored as the document itself (document kinds
   advance-directive, organ-donor-card, emergency-card), a summary line alone is not.
3. Otherwise tell the patient plainly, e.g. "Health Data Safe has no place for this kind of data
   yet, so I cannot store it properly. I will keep these values aside for now." Keep them in the
   conversation; write them nowhere. The patient keeps the original document.
4. Offer to report the gap so the data model can grow: the report_missing_item tool returns a
   link to a prefilled GitHub issue on healthdatasafe/site-agents (template "Data model gap").
   The patient opens the link and posts it themselves; you never post it. It needs a free GitHub
   account; help: https://agents.datasafe.dev/feedback
5. The report holds only the kind of data, its codes (LOINC, SNOMED-CT, ...) and its unit: never
   the patient's values, names, dates, doctors or any other detail of their records. Show the
   patient the text before they post it.
6. Once the data model has the item or the unit, import the values kept aside. A lab result
   stored meanwhile in lab-result/coded-v1 moves to its item with update_event, in place (same
   id, same sourceKey): data-model BLOOD-CHEMISTRY.md § Moving a result to its item.
`
};
