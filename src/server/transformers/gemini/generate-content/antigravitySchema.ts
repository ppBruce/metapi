/**
 * JSON Schema compatibility cleaners for Google's Antigravity upstream.
 *
 * Ported from CLIProxyAPI `internal/util/gemini_schema.go`
 * (`CleanJSONSchemaForAntigravity` / `CleanJSONSchemaForGemini`).
 *
 * The upstream tool-calling validator rejects most of modern JSON Schema:
 * `$ref`, `allOf`/`anyOf`/`oneOf`, type unions, and a long list of validation
 * keywords. Rather than dropping that information outright, the cleaners fold
 * it into the `description` text so the model still sees the constraint, then
 * strip the keywords the API refuses.
 *
 * Deviation from the Go implementation (deliberate): Go rewrites the whole
 * request payload string, so a user message that happens to contain a key
 * named `pattern` or `format` can be mangled. Here the cleaners are applied
 * only to the actual schema subtrees (tool parameters, `responseSchema`,
 * `responseJsonSchema`), which is where the upstream validator looks.
 */

type SchemaRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SchemaRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const PLACEHOLDER_REASON_DESCRIPTION = 'Brief explanation of why you are calling this tool';

/**
 * Validation keywords the upstream rejects. Their values are preserved as
 * description hints before removal.
 */
const UNSUPPORTED_CONSTRAINTS = [
  'minLength', 'maxLength', 'exclusiveMinimum', 'exclusiveMaximum',
  'pattern', 'minItems', 'maxItems', 'uniqueItems', 'format',
  // Claude rejects these in VALIDATED mode.
  'default', 'examples',
] as const;

const UNSUPPORTED_KEYWORDS = [
  ...UNSUPPORTED_CONSTRAINTS,
  '$schema', '$defs', 'definitions', 'const', '$ref', '$id', 'additionalProperties',
  // Schema keywords Gemini does not understand.
  'propertyNames', 'patternProperties',
  // Schema metadata fields unsupported by Gemini.
  'enumTitles', 'prefill', 'deprecated',
] as const;

/** Keys whose values are nested schemas keyed by caller-controlled names. */
const NAMED_SCHEMA_MAP_KEYS = ['properties', '$defs', 'definitions', 'patternProperties'] as const;

/** Keys whose values are a single nested schema. */
const SINGLE_SCHEMA_KEYS = ['items', 'additionalItems', 'contains', 'not', 'propertyNames'] as const;

/** Keys whose values are an array of nested schemas. */
const SCHEMA_LIST_KEYS = ['prefixItems'] as const;

function appendHint(node: SchemaRecord, hint: string): void {
  const existing = typeof node.description === 'string' ? node.description : '';
  node.description = existing ? `${existing} (${hint})` : hint;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (item === null || item === undefined ? '' : String(item)));
}

function removeFromRequired(node: SchemaRecord, names: string[]): void {
  if (!Array.isArray(node.required) || names.length <= 0) return;
  const filtered = asStringList(node.required).filter((name) => !names.includes(name));
  if (filtered.length <= 0) {
    delete node.required;
    return;
  }
  node.required = filtered;
}

/** `$ref` cannot be resolved upstream, so degrade it to a described object. */
function convertRefToHint(node: SchemaRecord): SchemaRecord {
  const ref = typeof node.$ref === 'string' ? node.$ref : '';
  const separatorIndex = ref.lastIndexOf('/');
  const defName = separatorIndex >= 0 ? ref.slice(separatorIndex + 1) : ref;
  const existing = typeof node.description === 'string' ? node.description : '';
  const hint = `See: ${defName}`;
  return {
    type: 'object',
    description: existing ? `${existing} (${hint})` : hint,
  };
}

/** Merge `allOf` members into the parent node, then drop the keyword. */
function mergeAllOf(node: SchemaRecord): void {
  if (!Array.isArray(node.allOf)) return;
  for (const member of node.allOf) {
    if (!isRecord(member)) continue;
    if (isRecord(member.properties)) {
      const properties = isRecord(node.properties) ? node.properties : {};
      for (const [key, value] of Object.entries(member.properties)) {
        properties[key] = value;
      }
      node.properties = properties;
    }
    if (Array.isArray(member.required)) {
      const current = asStringList(node.required);
      for (const name of asStringList(member.required)) {
        if (!current.includes(name)) current.push(name);
      }
      node.required = current;
    }
  }
  delete node.allOf;
}

/**
 * Pick the most structured variant of an `anyOf`/`oneOf`, mirroring Go's
 * scoring: object > array > concrete scalar > null.
 */
function selectBestVariant(items: unknown[]): { bestIndex: number; types: string[] } {
  let bestScore = -1;
  let bestIndex = 0;
  const types: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const record = isRecord(items[index]) ? items[index] as SchemaRecord : {};
    let type = typeof record.type === 'string' ? record.type : '';
    let score = 0;

    if (type === 'object' || isRecord(record.properties)) {
      score = 3;
      type = type || 'object';
    } else if (type === 'array' || record.items !== undefined) {
      score = 2;
      type = type || 'array';
    } else if (type !== '' && type !== 'null') {
      score = 1;
    } else {
      type = type || 'null';
    }

    if (type) types.push(type);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  return { bestIndex, types };
}

/** Collapse `anyOf`/`oneOf` to a single variant, keeping the rest as a hint. */
function flattenAnyOfOneOf(node: SchemaRecord): SchemaRecord | null {
  for (const key of ['anyOf', 'oneOf'] as const) {
    const variants = node[key];
    if (!Array.isArray(variants) || variants.length <= 0) continue;

    const parentDescription = typeof node.description === 'string' ? node.description : '';
    const { bestIndex, types } = selectBestVariant(variants);
    const selectedRaw = variants[bestIndex];
    const selected: SchemaRecord = isRecord(selectedRaw) ? { ...selectedRaw } : { type: 'object' };

    if (parentDescription) {
      const childDescription = typeof selected.description === 'string' ? selected.description : '';
      if (!childDescription) {
        selected.description = parentDescription;
      } else if (childDescription !== parentDescription) {
        selected.description = `${parentDescription} (${childDescription})`;
      }
    }
    if (types.length > 1) {
      appendHint(selected, `Accepts: ${types.join(' | ')}`);
    }
    return selected;
  }
  return null;
}

/**
 * Collapse a `type` array to a single type. Returns true when `null` was one
 * of the members, so the parent can drop the field from `required`.
 */
function flattenTypeArray(node: SchemaRecord): boolean {
  if (!Array.isArray(node.type) || node.type.length <= 0) return false;

  let hasNull = false;
  const nonNullTypes: string[] = [];
  for (const entry of asStringList(node.type)) {
    if (entry === 'null') hasNull = true;
    else if (entry) nonNullTypes.push(entry);
  }

  node.type = nonNullTypes[0] || 'string';
  if (nonNullTypes.length > 1) {
    appendHint(node, `Accepts: ${nonNullTypes.join(' | ')}`);
  }
  if (hasNull) {
    appendHint(node, '(nullable)');
  }
  return hasNull;
}

function convertConstAndEnums(node: SchemaRecord): void {
  if (node.const !== undefined && node.enum === undefined) {
    node.enum = [node.const];
  }
  if (!Array.isArray(node.enum)) return;

  // Antigravity only allows `enum` on STRING-typed schemas.
  const values = asStringList(node.enum);
  node.enum = values;
  node.type = 'string';
  if (values.length > 1 && values.length <= 10) {
    appendHint(node, `Allowed: ${values.join(', ')}`);
  }
}

function moveConstraintsToDescription(node: SchemaRecord): void {
  for (const key of UNSUPPORTED_CONSTRAINTS) {
    const value = node[key];
    if (value === undefined || isRecord(value) || Array.isArray(value)) continue;
    appendHint(node, `${key}: ${String(value)}`);
  }
}

/** Drop `required` entries that have no matching property definition. */
function cleanupRequiredFields(node: SchemaRecord): void {
  if (!Array.isArray(node.required) || !isRecord(node.properties)) return;
  const properties = node.properties;
  const required = asStringList(node.required);
  const valid = required.filter((name) => properties[name] !== undefined);
  if (valid.length === required.length) return;
  if (valid.length <= 0) {
    delete node.required;
    return;
  }
  node.required = valid;
}

/**
 * Claude's VALIDATED mode requires every object schema to have at least one
 * required property, so empty schemas get a synthetic one.
 */
function addEmptySchemaPlaceholder(node: SchemaRecord, isRoot: boolean): void {
  if (node.type !== 'object') return;

  const properties = isRecord(node.properties) ? node.properties : null;
  const hasRequired = Array.isArray(node.required) && node.required.length > 0;

  if (!properties || Object.keys(properties).length <= 0) {
    node.properties = {
      reason: { type: 'string', description: PLACEHOLDER_REASON_DESCRIPTION },
    };
    node.required = ['reason'];
    return;
  }

  // Go skips the `_` placeholder for the top-level schema.
  if (!hasRequired && !isRoot) {
    if (properties._ === undefined) {
      properties._ = { type: 'boolean' };
    }
    node.required = ['_'];
  }
}

/** Reverse of {@link addEmptySchemaPlaceholder} for the Gemini variant. */
function removePlaceholderFields(node: SchemaRecord): void {
  const properties = isRecord(node.properties) ? node.properties : null;
  if (!properties) return;

  if (properties._ !== undefined) {
    delete properties._;
    removeFromRequired(node, ['_']);
  }

  const reason = properties.reason;
  if (
    isRecord(reason)
    && Object.keys(properties).length === 1
    && reason.description === PLACEHOLDER_REASON_DESCRIPTION
  ) {
    delete properties.reason;
    removeFromRequired(node, ['reason']);
  }
}

function removeUnsupportedKeywords(node: SchemaRecord, addPlaceholder: boolean): void {
  for (const key of UNSUPPORTED_KEYWORDS) {
    delete node[key];
  }
  for (const key of Object.keys(node)) {
    // OpenAPI/JSON Schema `x-*` extensions (e.g. x-google-enum-descriptions).
    if (key.startsWith('x-')) delete node[key];
  }
  if (!addPlaceholder) {
    delete node.nullable;
    delete node.title;
  }
}

/**
 * Clean one schema node and everything below it.
 *
 * @returns the cleaned node, plus whether it declared `null` as a valid type
 *          (the caller strips such fields from its `required` list).
 */
function cleanSchemaNode(
  value: unknown,
  addPlaceholder: boolean,
  depth: number,
): { node: unknown; nullable: boolean } {
  if (Array.isArray(value)) {
    return {
      node: value.map((item) => cleanSchemaNode(item, addPlaceholder, depth + 1).node),
      nullable: false,
    };
  }
  if (!isRecord(value) || depth > 64) {
    return { node: value, nullable: false };
  }

  let node: SchemaRecord = { ...value };

  // Resolve structural indirection first so merged-in subschemas are cleaned
  // by the recursion below. Bounded in case a variant nests another one.
  for (let iteration = 0; iteration < 8; iteration += 1) {
    if (node.$ref !== undefined) {
      node = convertRefToHint(node);
      break;
    }
    if (Array.isArray(node.allOf)) {
      mergeAllOf(node);
      continue;
    }
    const flattened = flattenAnyOfOneOf(node);
    if (flattened) {
      node = flattened;
      continue;
    }
    break;
  }

  convertConstAndEnums(node);
  if (node.additionalProperties === false) {
    appendHint(node, 'No extra properties allowed');
  }
  moveConstraintsToDescription(node);
  const nullable = flattenTypeArray(node);

  for (const key of NAMED_SCHEMA_MAP_KEYS) {
    const map = node[key];
    if (!isRecord(map)) continue;
    const cleanedMap: SchemaRecord = {};
    const nullableNames: string[] = [];
    for (const [name, child] of Object.entries(map)) {
      const cleaned = cleanSchemaNode(child, addPlaceholder, depth + 1);
      cleanedMap[name] = cleaned.node;
      if (cleaned.nullable) nullableNames.push(name);
    }
    node[key] = cleanedMap;
    // A nullable property cannot be required upstream.
    if (key === 'properties') removeFromRequired(node, nullableNames);
  }

  for (const key of SINGLE_SCHEMA_KEYS) {
    if (!isRecord(node[key])) continue;
    node[key] = cleanSchemaNode(node[key], addPlaceholder, depth + 1).node;
  }

  for (const key of SCHEMA_LIST_KEYS) {
    const list = node[key];
    if (!Array.isArray(list)) continue;
    node[key] = list.map((item) => cleanSchemaNode(item, addPlaceholder, depth + 1).node);
  }

  if (isRecord(node.additionalProperties)) {
    node.additionalProperties = cleanSchemaNode(
      node.additionalProperties,
      addPlaceholder,
      depth + 1,
    ).node;
  }

  removeUnsupportedKeywords(node, addPlaceholder);
  if (!addPlaceholder) removePlaceholderFields(node);
  cleanupRequiredFields(node);
  if (addPlaceholder) addEmptySchemaPlaceholder(node, depth === 0);

  return { node, nullable };
}

/**
 * Clean a JSON schema for Antigravity (Claude / Gemini 3 Pro) tool calling.
 * Adds placeholder properties to empty object schemas, which Claude's
 * VALIDATED mode requires.
 */
export function cleanJsonSchemaForAntigravity(schema: unknown): unknown {
  return cleanSchemaNode(schema, true, 0).node;
}

/**
 * Clean a JSON schema for standard Gemini tool calling. Same keyword removal,
 * but without placeholder injection, and additionally strips `nullable`,
 * `title`, and any placeholder fields left over from the Antigravity variant.
 */
export function cleanJsonSchemaForGemini(schema: unknown): unknown {
  return cleanSchemaNode(schema, false, 0).node;
}

/**
 * Whether a model uses the stricter Antigravity schema dialect.
 *
 * Mirrors CLIProxyAPI's `useAntigravitySchema` predicate. Note that upstream
 * this list differs from the stream-endpoint routing list in
 * `antigravityRuntime.ts` (`gemini-3.1-pro` here vs `gemini-3.1-flash-image`
 * there); both are reproduced as-is.
 */
export function usesAntigravitySchemaDialect(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return normalized.includes('claude')
    || normalized.includes('gemini-3-pro')
    || normalized.includes('gemini-3.1-pro');
}

function collectRequestSchemaHosts(request: SchemaRecord): Array<{
  host: SchemaRecord;
  key: string;
}> {
  const hosts: Array<{ host: SchemaRecord; key: string }> = [];

  const tools = request.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!isRecord(tool)) continue;
      const declarations = tool.functionDeclarations;
      if (!Array.isArray(declarations)) continue;
      for (const declaration of declarations) {
        if (!isRecord(declaration)) continue;
        for (const key of ['parameters', 'parametersJsonSchema', 'response', 'responseJsonSchema']) {
          if (isRecord(declaration[key])) hosts.push({ host: declaration, key });
        }
      }
    }
  }

  const generationConfig = request.generationConfig;
  if (isRecord(generationConfig)) {
    for (const key of ['responseSchema', 'responseJsonSchema']) {
      if (isRecord(generationConfig[key])) hosts.push({ host: generationConfig, key });
    }
  }

  return hosts;
}

/**
 * Whether the payload carries anything the schema cleaners would touch.
 * Mirrors Go's `antigravityRequestNeedsSchemaSanitization`.
 */
export function antigravityRequestNeedsSchemaSanitization(payload: SchemaRecord): boolean {
  const request = payload.request;
  if (!isRecord(request)) return false;

  if (Array.isArray(request.tools) && request.tools.length > 0) return true;
  const generationConfig = request.generationConfig;
  if (!isRecord(generationConfig)) return false;
  return generationConfig.responseJsonSchema !== undefined
    || generationConfig.responseSchema !== undefined;
}

/**
 * Apply the model-appropriate schema cleaner to every schema in an Antigravity
 * runtime payload, in place.
 */
export function sanitizeAntigravityRequestSchemas(
  payload: SchemaRecord,
  modelName: string,
): void {
  if (!antigravityRequestNeedsSchemaSanitization(payload)) return;
  const request = payload.request;
  if (!isRecord(request)) return;

  const clean = usesAntigravitySchemaDialect(modelName)
    ? cleanJsonSchemaForAntigravity
    : cleanJsonSchemaForGemini;

  for (const { host, key } of collectRequestSchemaHosts(request)) {
    host[key] = clean(host[key]);
  }
}
