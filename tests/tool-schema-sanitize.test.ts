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

  it('keeps lookaround, which both dialects compile', () => {
    expect(isCompatiblePattern(ARTIFACT_COLLECTION_PATTERN)).toBe(true);
    expect(isCompatiblePattern(String.raw`^(?!__)(?<=a)(?<!b)x$`)).toBe(true);
  });

  it('rejects JS-only named groups and backreferences', () => {
    expect(isCompatiblePattern(String.raw`(?<year>\d{4})`)).toBe(false);
    expect(isCompatiblePattern(String.raw`(?<y>a)\k<y>`)).toBe(false);
  });

  it('reads an escaped backslash as a literal, not as the start of an escape', () => {
    // `\\p{2}` is a backslash repeated twice then `{2}` — compilable in both.
    expect(isCompatiblePattern(String.raw`^a\\p{2}$`)).toBe(true);
    expect(isCompatiblePattern(String.raw`^[A-Za-z0-9_=-]{1,4096}$`)).toBe(true);
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
});
