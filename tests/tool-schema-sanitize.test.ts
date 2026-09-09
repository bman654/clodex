import { describe, it, expect } from 'vitest';
import { isCompatiblePattern, sanitizeToolSchema } from '../src/tool-schema-sanitize.js';

// Claude Code 2.1.266's Artifact schema, verbatim: `field` is the pattern OpenAI
// rejected in #194, `collection` the lookahead that compiles in both dialects.
const ARTIFACT_FIELD_PATTERN = String.raw`^(?!__.*__$)[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\./[\]]{1,200}$`;
const ARTIFACT_COLLECTION_PATTERN =
  String.raw`^(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}){0,14}$`;

describe('isCompatiblePattern', () => {
  it('rejects the Unicode property escapes Python cannot compile', () => {
    expect(isCompatiblePattern(ARTIFACT_FIELD_PATTERN)).toBe(false);
    expect(isCompatiblePattern(String.raw`^\p{L}+$`)).toBe(false);
    expect(isCompatiblePattern(String.raw`^\P{Nd}+$`)).toBe(false);
  });

  it('keeps simple lookahead and fixed-width lookbehind, which both dialects compile', () => {
    expect(isCompatiblePattern(ARTIFACT_COLLECTION_PATTERN)).toBe(true);
    expect(isCompatiblePattern(String.raw`^(?!__)(?<=a)(?<!b)x$`)).toBe(true);
  });

  it('rejects JS-only named groups and backreferences', () => {
    expect(isCompatiblePattern(String.raw`(?<year>\d{4})`)).toBe(false);
    expect(isCompatiblePattern(String.raw`(?<y>a)\k<y>`)).toBe(false);
  });

  it('reads an escaped backslash as a literal, not as the start of an escape', () => {
    // `\\p{2}` is an escaped backslash then `p{2}` — a literal backslash
    // followed by two `p`s, compilable in both. Not the `\p{...}` escape.
    expect(isCompatiblePattern(String.raw`^a\\p{2}$`)).toBe(true);
    expect(isCompatiblePattern(String.raw`^[A-Za-z0-9_=-]{1,4096}$`)).toBe(true);
  });

  it('rejects the braced u/x escapes, which are the same u-flag family as the property escapes', () => {
    // Python: "incomplete escape \u at position 1". The u flag that makes these
    // legal in ECMAScript is lost when RegExp.source lands in the schema.
    expect(isCompatiblePattern(String.raw`^\u{41}+$`)).toBe(false);
    expect(isCompatiblePattern(String.raw`^\x{41}+$`)).toBe(false);
    // `\u{}` is genuinely the u-flag form; `\x{}` is not (under `u` it throws,
    // and in a legacy regex it reads as "x, 41 times"). It goes because an
    // author can still write the string and Python rejects it outright.
    // The braceless forms are spelled identically in both dialects and stay.
    expect(isCompatiblePattern(String.raw`^A\x41$`)).toBe(true);
  });

  it('rejects the `\\k<name>` source shape even with no named group to trip on first', () => {
    // Isolates the \k guard: `(?<y>a)\k<y>` would be rejected by the named-group
    // check alone, so it pins nothing. Without a named group and outside `u`
    // mode this is a legacy identity escape rather than a live backreference,
    // but it is the JS-only spelling either way, and Python rejects it.
    expect(isCompatiblePattern(String.raw`a\k<y>`)).toBe(false);
  });

  it('reads `(?<` inside a character class as three literal characters', () => {
    // A class listing `(`, `?` and `<` is not a named group. Python compiles it.
    expect(isCompatiblePattern(String.raw`^[(?<]+$`)).toBe(true);
    expect(isCompatiblePattern(String.raw`^[]<]?(?<name>x)$`)).toBe(false);
    // ...and a class is not a blanket amnesty: \p{} inside one still goes.
    expect(isCompatiblePattern(String.raw`^[^\p{Cc}]$`)).toBe(false);
  });
});

describe('sanitizeToolSchema', () => {
  it('drops only the incompatible pattern, keeping the property it constrained', () => {
    const sanitized = sanitizeToolSchema({
      type: 'object',
      properties: {
        field: { type: 'string', pattern: ARTIFACT_FIELD_PATTERN, description: 'one plain key' },
        collection: { type: 'string', pattern: ARTIFACT_COLLECTION_PATTERN, maxLength: 1000 },
      },
      required: ['field'],
    });
    expect(sanitized).toEqual({
      type: 'object',
      properties: {
        field: { type: 'string', description: 'one plain key' },
        collection: { type: 'string', pattern: ARTIFACT_COLLECTION_PATTERN, maxLength: 1000 },
      },
      required: ['field'],
    });
  });

  it('strips at any depth', () => {
    const sanitized = sanitizeToolSchema({
      type: 'object',
      properties: {
        contract: { anyOf: [{ const: 'latest' }, { type: 'string', pattern: String.raw`^\p{Nd}+$` }] },
        writes: { type: 'array', items: { properties: { doc_id: { pattern: String.raw`\p{L}` } } } },
      },
    }) as any;
    expect(sanitized.properties.contract.anyOf).toEqual([{ const: 'latest' }, { type: 'string' }]);
    expect(sanitized.properties.writes.items.properties.doc_id).toEqual({});
  });

  it('leaves a tool parameter named `pattern` alone', () => {
    // Grep's `pattern` is a property name, not the JSON Schema keyword.
    const grep = {
      type: 'object',
      properties: { pattern: { type: 'string', description: 'the regex to search for' } },
      required: ['pattern'],
    };
    expect(sanitizeToolSchema(grep)).toBe(grep);
  });

  it('returns a schema with nothing to strip by identity', () => {
    const schema = { type: 'object', properties: { path: { type: 'string', pattern: '^/' } } };
    expect(sanitizeToolSchema(schema)).toBe(schema);
  });

  it('passes through values that are not schemas', () => {
    expect(sanitizeToolSchema(undefined)).toBeUndefined();
    expect(sanitizeToolSchema('pattern')).toBe('pattern');
  });

  it('drops a patternProperties entry whose KEY is a regex Python cannot compile', () => {
    // The key is itself a regex the far side compiles: jsonschema's 2020-12
    // applicator vocabulary gives `patternProperties.propertyNames` the
    // `format: "regex"` check, and a bad key returns the same
    // `'<key>' is not a 'regex'` 400 that a bad `pattern` value does.
    const sanitized = sanitizeToolSchema({
      type: 'object',
      patternProperties: {
        [String.raw`^\p{L}+$`]: { type: 'string' },
        '^[a-z_]+$': { type: 'number' },
      },
    });
    expect(sanitized).toEqual({
      type: 'object',
      patternProperties: { '^[a-z_]+$': { type: 'number' } },
    });
  });

  it('opens a sibling closure when it drops a patternProperties entry, so the schema never narrows', () => {
    // Without this, `{"abc":"ok"}` goes from accepted to REJECTED: the dropped
    // entry was the only thing admitting those keys, and additionalProperties
    // then forbids them. Sanitizing must only ever loosen.
    const bad = String.raw`^\p{L}+$`;
    expect(sanitizeToolSchema({
      type: 'object', patternProperties: { [bad]: { type: 'string' } }, additionalProperties: false,
    })).toEqual({ type: 'object', patternProperties: {} });
    // A closure that re-constrains rather than forbids narrows just as much.
    expect(sanitizeToolSchema({
      type: 'object', patternProperties: { [bad]: { type: 'string' } }, additionalProperties: { type: 'number' },
    })).toEqual({ type: 'object', patternProperties: {} });
    expect(sanitizeToolSchema({
      type: 'object', patternProperties: { [bad]: { type: 'string' } }, unevaluatedProperties: false,
    })).toEqual({ type: 'object', patternProperties: {} });
    // `true` is already the permissive default, so it is left as written.
    expect(sanitizeToolSchema({
      type: 'object', patternProperties: { [bad]: { type: 'string' } }, additionalProperties: true,
    })).toEqual({ type: 'object', patternProperties: {}, additionalProperties: true });
  });

  it('leaves a closure keyword alone when no patternProperties entry was dropped', () => {
    // Over-scope negative: only a dropped KEY may open the closure. A stripped
    // `pattern`, or a bad key one level down, must not touch this schema's own
    // additionalProperties.
    expect(sanitizeToolSchema({
      type: 'object',
      properties: { f: { type: 'string', pattern: String.raw`^\p{L}+$` } },
      patternProperties: { '^x': { type: 'string' } },
      additionalProperties: false,
    })).toEqual({
      type: 'object',
      properties: { f: { type: 'string' } },
      patternProperties: { '^x': { type: 'string' } },
      additionalProperties: false,
    });
    const nested = sanitizeToolSchema({
      type: 'object',
      additionalProperties: false,
      properties: { inner: { patternProperties: { [String.raw`^\p{L}+$`]: {} }, additionalProperties: false } },
    }) as any;
    expect(nested.additionalProperties).toBe(false);      // outer untouched
    expect(nested.properties.inner.additionalProperties).toBeUndefined(); // inner opened
  });

  it('drops a bad patternProperties key nested under $defs', () => {
    const sanitized = sanitizeToolSchema({
      $defs: { bag: { type: 'object', patternProperties: { [String.raw`^\p{Nd}$`]: { type: 'string' } } } },
      $ref: '#/$defs/bag',
    }) as any;
    expect(sanitized.$defs.bag.patternProperties).toEqual({});
  });

  it('walks the values of a patternProperties entry it keeps', () => {
    const sanitized = sanitizeToolSchema({
      patternProperties: { '^x': { type: 'string', pattern: String.raw`\p{L}` } },
    }) as any;
    expect(sanitized.patternProperties['^x']).toEqual({ type: 'string' });
  });

  it('leaves instance-data keywords opaque, because editing them changes what the schema accepts', () => {
    // `const`/`enum` say which VALUES are allowed; a member named `pattern`
    // there is data, not a rule. Deleting it silently changes the contract.
    const schema = {
      type: 'object',
      properties: {
        rule: {
          const: { pattern: String.raw`^\p{L}+$`, flags: 'u' },
        },
        preset: {
          enum: [{ pattern: String.raw`^\p{L}+$` }, 'none'],
          default: { pattern: String.raw`^\p{L}+$` },
          examples: [{ pattern: String.raw`^\p{L}+$` }],
        },
      },
    };
    // Nothing to strip anywhere, so the whole schema comes back by identity.
    expect(sanitizeToolSchema(schema)).toBe(schema);
  });

  it('strips through every declared schema position', () => {
    const bad = String.raw`^\p{L}+$`;
    const sanitized = sanitizeToolSchema({
      if: { pattern: bad },
      then: { pattern: bad },
      else: { pattern: bad },
      not: { pattern: bad },
      contains: { pattern: bad },
      propertyNames: { pattern: bad },
      additionalProperties: { pattern: bad },
      unevaluatedProperties: { pattern: bad },
      unevaluatedItems: { pattern: bad },
      additionalItems: { pattern: bad },
      prefixItems: [{ pattern: bad }],
      items: [{ pattern: bad }],
      allOf: [{ pattern: bad }],
      oneOf: [{ pattern: bad }],
      contentSchema: { pattern: bad },
      dependentSchemas: { other: { pattern: bad } },
      definitions: { legacy: { pattern: bad } },
      dependencies: { legacyDep: { pattern: bad } },
    }) as any;
    for (const key of [
      'if', 'then', 'else', 'not', 'contains', 'propertyNames',
      'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'additionalItems',
      'contentSchema',
    ]) expect(sanitized[key], key).toEqual({});
    for (const key of ['prefixItems', 'items', 'allOf', 'oneOf']) expect(sanitized[key], key).toEqual([{}]);
    expect(sanitized.dependentSchemas.other).toEqual({});
    expect(sanitized.definitions.legacy).toEqual({});
    expect(sanitized.dependencies.legacyDep).toEqual({});
  });

  it("keeps draft-07 `dependencies`' other form, a plain array of property names", () => {
    const schema = { dependencies: { card: ['number', 'expiry'] } };
    expect(sanitizeToolSchema(schema)).toBe(schema);
  });

  it('keeps a __proto__ key in every map it copies', () => {
    // Assigning `out.__proto__` hits Object.prototype's setter and silently
    // drops the key; the copies are built with Object.fromEntries, which
    // *defines* it. Staged through JSON.parse because an object *literal* with
    // a `__proto__` key sets the prototype rather than creating the own
    // property — JSON.parse is also how a real `input_schema` arrives.
    const bad = String.raw`^\p{L}+$`;
    const schema = JSON.parse(JSON.stringify({
      type: 'object',
      PROTO: 'an unknown keyword, forwarded verbatim',
      properties: { PROTO: { type: 'string' }, field: { type: 'string', pattern: bad } },
      $defs: { PROTO: { type: 'string' } },
      patternProperties: { PROTO: { type: 'string' }, BADKEY: { type: 'string' } },
    }).replaceAll('"PROTO"', '"__proto__"').replaceAll('"BADKEY"', JSON.stringify(bad)));

    const sanitized = sanitizeToolSchema(schema) as any;
    // The schema object itself, and each of the three name-keyed maps.
    expect(Object.keys(sanitized)).toContain('__proto__');
    expect(Object.keys(sanitized.properties)).toEqual(['__proto__', 'field']);
    expect(Object.keys(sanitized.$defs)).toEqual(['__proto__']);
    expect(Object.keys(sanitized.patternProperties)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(sanitized.properties, '__proto__')?.value)
      .toEqual({ type: 'string' });
    expect(({} as any).type).toBeUndefined(); // no prototype pollution either way
  });

  it('keeps a compatible pattern when a sibling forces the schema to be rebuilt', () => {
    // The copy is only taken when something changed; the compatible `pattern`
    // has to be carried into it. With the node returned by identity (no
    // sibling to strip) this branch never runs.
    const sanitized = sanitizeToolSchema({
      type: 'string',
      pattern: '^ok$',
      allOf: [{ pattern: String.raw`^\p{L}+$` }],
    });
    expect(sanitized).toEqual({ type: 'string', pattern: '^ok$', allOf: [{}] });
  });

  it('never reads a name-keyed map KEY as a regex', () => {
    // Only `pattern` values and `patternProperties` keys are regex positions.
    // A property or definition merely *named* like a regex is a name.
    const schema = {
      properties: { [String.raw`\p{L}`]: { type: 'string' } },
      $defs: { [String.raw`\p{Nd}`]: { type: 'number' } },
      dependencies: { [String.raw`\p{L}`]: ['x'] },
    };
    expect(sanitizeToolSchema(schema)).toBe(schema);
  });

  it('leaves a non-string `pattern` value verbatim rather than guessing', () => {
    // Malformed as JSON Schema, but valid JSON on the wire. It is not a regex
    // and not a schema position, so it is neither tested nor walked.
    const schema = { pattern: ['\\', 'p', '{'] };
    expect(sanitizeToolSchema(schema)).toBe(schema);
    const numeric = { properties: { x: { pattern: 42 } } };
    expect(sanitizeToolSchema(numeric)).toBe(numeric);
  });

  it('returns unchanged arrays and patternProperties maps by identity', () => {
    const list = { prefixItems: [{ type: 'string' }] };
    expect(sanitizeToolSchema(list)).toBe(list);
    expect((sanitizeToolSchema(list) as any).prefixItems).toBe(list.prefixItems);
    const map = { patternProperties: { '^x': { type: 'string' } } };
    expect(sanitizeToolSchema(map)).toBe(map);
    expect((sanitizeToolSchema(map) as any).patternProperties).toBe(map.patternProperties);
  });

  it('survives a malformed schema instead of throwing on the request path', () => {
    // A tool ships whatever `input_schema` its author wrote; a null or an array
    // where a subschema map belongs must not take the whole request down.
    for (const schema of [
      { properties: null },
      { $defs: null },
      { patternProperties: null },
      { properties: ['not', 'a', 'map'] },
      { patternProperties: ['not', 'a', 'map'] },
      { items: null },
    ]) {
      expect(() => sanitizeToolSchema(schema), JSON.stringify(schema)).not.toThrow();
      expect(sanitizeToolSchema(schema), JSON.stringify(schema)).toBe(schema);
    }
    expect(sanitizeToolSchema(null)).toBeNull();
  });

  it('does not mutate the schema it was given', () => {
    const schema = {
      type: 'object',
      properties: { field: { type: 'string', pattern: ARTIFACT_FIELD_PATTERN } },
      patternProperties: { [String.raw`^\p{L}+$`]: { type: 'string' } },
    };
    const before = structuredClone(schema);
    const sanitized = sanitizeToolSchema(deepFreeze(schema)) as any;
    expect(schema).toEqual(before);
    expect(sanitized).not.toBe(schema);
    expect(sanitized.properties.field).toEqual({ type: 'string' });
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}
