import { describe, it, expect } from 'vitest';
import { coerceEchoedScalar, schemaScalarKind } from '../src/tool-input-coerce.js';

// The accepted spellings are the UNION of Claude Code's two client rules (see the
// module header): Bash `timeout` / Read `offset` go through `UF` (trim, decimal
// literal, `Number`); every other number/integer/boolean property goes through
// the generic repair (JSON-parse, numbers kept only if they print back
// identically, booleans after one BOM strip). Rows were executed against the
// 2.1.273 bundle's own functions and cross-checked with real-binary captures.

describe('schemaScalarKind', () => {
  it('names the scalar kind a `type` string declares', () => {
    expect(schemaScalarKind({ type: 'number' })).toBe('number');
    // A typed enum is still typed; only an enum WITHOUT a scalar `type` is declined.
    expect(schemaScalarKind({ type: 'number', enum: [1, 2, 3] })).toBe('number');
    expect(schemaScalarKind({ type: 'boolean', const: true })).toBe('boolean');
    expect(schemaScalarKind({ type: 'integer', minimum: 0 })).toBe('integer');
    expect(schemaScalarKind({ type: 'boolean', default: false })).toBe('boolean');
    expect(schemaScalarKind({ type: 'string' })).toBeUndefined();
    expect(schemaScalarKind({ type: 'array' })).toBeUndefined();
    expect(schemaScalarKind({ type: 'object' })).toBeUndefined();
    expect(schemaScalarKind({ type: 'null' })).toBeUndefined();
  });

  it('resolves a `type` array with the client\'s preference', () => {
    expect(schemaScalarKind({ type: ['number', 'null'] })).toBe('number');
    expect(schemaScalarKind({ type: ['null', 'integer'] })).toBe('integer');
    expect(schemaScalarKind({ type: ['integer', 'boolean'] })).toBe('integer');
    expect(schemaScalarKind({ type: ['boolean', 'integer'] })).toBe('boolean');
    expect(schemaScalarKind({ type: ['string', 'number'] })).toBeUndefined();
    expect(schemaScalarKind({ type: ['number', 'string'] })).toBeUndefined();
    expect(schemaScalarKind({ type: ['number', 'array'] })).toBeUndefined();
    expect(schemaScalarKind({ type: ['null'] })).toBeUndefined();
    expect(schemaScalarKind({ type: [] })).toBeUndefined();
  });

  it('resolves anyOf and oneOf branches under the same preference', () => {
    expect(schemaScalarKind({ anyOf: [{ type: 'number' }, { type: 'null' }] })).toBe('number');
    expect(schemaScalarKind({ oneOf: [{ type: 'integer' }, { type: 'null' }] })).toBe('integer');
    expect(schemaScalarKind({ anyOf: [{ type: 'integer' }, { type: 'number' }] })).toBe('integer');
    expect(schemaScalarKind({ anyOf: [{ type: 'null' }, { anyOf: [{ type: 'boolean' }] }] })).toBe('boolean');
    expect(schemaScalarKind({ anyOf: [{ type: 'number' }, { type: 'string' }] })).toBeUndefined();
    expect(schemaScalarKind({ anyOf: [{ type: 'number' }, { type: 'object' }] })).toBeUndefined();
    expect(schemaScalarKind({ anyOf: [{ type: 'null' }], oneOf: [{ type: 'number' }] })).toBe('number');
    expect(schemaScalarKind({ anyOf: [] })).toBeUndefined();
  });

  it('follows a local $ref into the tool\'s $defs or definitions', () => {
    const parameters = {
      $defs: { Count: { type: 'integer' }, Flag: { anyOf: [{ type: 'boolean' }, { type: 'null' }] } },
    };
    expect(schemaScalarKind({ $ref: '#/$defs/Count' }, parameters)).toBe('integer');
    expect(schemaScalarKind({ $ref: '#/$defs/Flag' }, parameters)).toBe('boolean');
    expect(schemaScalarKind({ anyOf: [{ $ref: '#/$defs/Count' }, { type: 'null' }] }, parameters)).toBe('integer');
    expect(schemaScalarKind({ $ref: '#/definitions/N' }, { definitions: { N: { type: 'number' } } })).toBe('number');
    expect(schemaScalarKind({ $ref: '#/$defs/Missing' }, parameters)).toBeUndefined();
    expect(schemaScalarKind({ $ref: '#/$defs/Count' })).toBeUndefined();
    expect(schemaScalarKind({ $ref: 'https://example.com/schema.json#/x' }, parameters)).toBeUndefined();
    expect(schemaScalarKind({ $ref: '#/$defs/Count' }, { $defs: 'not-an-object' })).toBeUndefined();
    // A sibling `type` wins over `$ref`, as in the client.
    expect(schemaScalarKind({ type: 'string', $ref: '#/$defs/Count' }, parameters)).toBeUndefined();
    expect(schemaScalarKind({ type: 'boolean', $ref: '#/$defs/Count' }, parameters)).toBe('boolean');
  });

  it('mirrors the client\'s single-bucket lookup when both $defs and definitions exist', () => {
    // The client picks `$defs ?? definitions` once and resolves every local ref
    // against it, so a `#/definitions/X` ref reads `$defs.X` when both buckets
    // exist. Mirrored, not corrected: it can only equate two spellings of one
    // value, never two values.
    const both = { $defs: { X: { type: 'number' } }, definitions: { X: { type: 'string' } } };
    expect(schemaScalarKind({ $ref: '#/$defs/X' }, both)).toBe('number');
    expect(schemaScalarKind({ $ref: '#/definitions/X' }, both)).toBe('number');
    const swapped = { $defs: { X: { type: 'string' } }, definitions: { X: { type: 'number' } } };
    expect(schemaScalarKind({ $ref: '#/definitions/X' }, swapped)).toBeUndefined();
  });

  it('survives a cyclic or deep $ref chain', () => {
    const cyclic = { $defs: { A: { $ref: '#/$defs/B' }, B: { $ref: '#/$defs/A' } } };
    expect(schemaScalarKind({ $ref: '#/$defs/A' }, cyclic)).toBeUndefined();
    const defs: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) defs[`D${i}`] = { $ref: `#/$defs/D${i + 1}` };
    defs.D100 = { type: 'number' };
    expect(schemaScalarKind({ $ref: '#/$defs/D0' }, { $defs: defs })).toBeUndefined();
    const short: Record<string, unknown> = {};
    for (let i = 0; i < 10; i += 1) short[`D${i}`] = { $ref: `#/$defs/D${i + 1}` };
    short.D10 = { type: 'number' };
    expect(schemaScalarKind({ $ref: '#/$defs/D0' }, { $defs: short })).toBe('number');
  });

  it('mirrors the client\'s 64-visit cap across anyOf branches', () => {
    // The cap is global to one resolution, so a branch past it is not seen: 66
    // number branches followed by a string still resolve to number, exactly as
    // the client's `cMt` does. Mirrored because it only ever admits re-typing
    // (same-value spellings), never a different value.
    const many = Array.from({ length: 66 }, () => ({ type: 'number' }));
    expect(schemaScalarKind({ anyOf: [...many, { type: 'string' }] })).toBe('number');
    expect(schemaScalarKind({ anyOf: [...many.slice(0, 10), { type: 'string' }] })).toBeUndefined();
  });

  it('declines everything else', () => {
    expect(schemaScalarKind({ enum: [1, 2] })).toBeUndefined();
    expect(schemaScalarKind({ const: 5 })).toBeUndefined();
    expect(schemaScalarKind({ description: 'annotation only' })).toBeUndefined();
    expect(schemaScalarKind({})).toBeUndefined();
    expect(schemaScalarKind(undefined)).toBeUndefined();
    expect(schemaScalarKind(null)).toBeUndefined();
    expect(schemaScalarKind('number')).toBeUndefined();
    expect(schemaScalarKind([{ type: 'number' }])).toBeUndefined();
  });
});

describe('coerceEchoedScalar', () => {
  it('re-types the boolean spellings either client rule accepts', () => {
    expect(coerceEchoedScalar('true', 'boolean')).toBe(true);
    expect(coerceEchoedScalar('false', 'boolean')).toBe(false);
    // Generic repair: JSON.parse after a BOM strip, so surrounding JSON whitespace passes.
    expect(coerceEchoedScalar(' true ', 'boolean')).toBe(true);
    expect(coerceEchoedScalar('true\n', 'boolean')).toBe(true);
    expect(coerceEchoedScalar('﻿false', 'boolean')).toBe(false);
    expect(coerceEchoedScalar('\r\n\tfalse', 'boolean')).toBe(false);
  });

  it('leaves every boolean spelling neither client rule accepts', () => {
    // One BOM may precede the whitespace; whitespace before the BOM is not parsed.
    for (const spelling of [
      'True', 'FALSE', '0', '1', 'yes', 'no', '', ' ', '\u00A0true', 'true false', 'truex',
      ' \uFEFFtrue', '\uFEFF\uFEFFtrue', 'true\uFEFF',
    ]) {
      expect(coerceEchoedScalar(spelling, 'boolean'), JSON.stringify(spelling)).toBe(spelling);
    }
  });

  it('re-types a decimal literal after trimming, like the Bash and Read coercer', () => {
    expect(coerceEchoedScalar('5000', 'number')).toBe(5000);
    expect(coerceEchoedScalar('5000.0', 'number')).toBe(5000);
    expect(coerceEchoedScalar(' 5000 ', 'number')).toBe(5000);
    expect(coerceEchoedScalar('5\n', 'number')).toBe(5);
    expect(coerceEchoedScalar('﻿5', 'number')).toBe(5);
    expect(coerceEchoedScalar('05', 'number')).toBe(5);
    expect(coerceEchoedScalar('+5', 'number')).toBe(5);
    expect(coerceEchoedScalar('-12', 'number')).toBe(-12);
    expect(coerceEchoedScalar('5.5', 'number')).toBe(5.5);
    expect(coerceEchoedScalar('0.25', 'number')).toBe(0.25);
    expect(Object.is(coerceEchoedScalar('-0', 'number'), -0)).toBe(true);
    expect(coerceEchoedScalar('999999999999999', 'number')).toBe(999999999999999);
    expect(coerceEchoedScalar('0000000000000000000005', 'number')).toBe(5);
    expect(coerceEchoedScalar('0.00000000000001', 'number')).toBe(0.00000000000001);
  });

  it('leaves a decimal literal with more than 15 significant digits alone', () => {
    // The client re-types these too, but `Number()` is lossy past DBL_DIG:
    // "9007199254740993" and "9007199254740992" would become one double, so two
    // different raw values would compare equal. Fail closed instead.
    expect(coerceEchoedScalar('9007199254740993', 'number')).toBe('9007199254740993');
    expect(coerceEchoedScalar('9007199254740992', 'number')).toBe('9007199254740992');
    expect(coerceEchoedScalar('1000000000000000000000', 'number')).toBe('1000000000000000000000');
    expect(coerceEchoedScalar('1234567890.123456', 'number')).toBe('1234567890.123456');
    expect(coerceEchoedScalar('5000.000000000000', 'number')).toBe('5000.000000000000');
    // An overflowing decimal can never reach Number(): it is far past the digit cap.
    expect(coerceEchoedScalar(`1${'0'.repeat(400)}`, 'number')).toBe(`1${'0'.repeat(400)}`);
    expect(coerceEchoedScalar(`-1${'0'.repeat(400)}`, 'integer')).toBe(`-1${'0'.repeat(400)}`);
  });

  it('re-types the canonical exponent spellings the generic repair keeps', () => {
    expect(coerceEchoedScalar('1e+21', 'number')).toBe(1e21);
    expect(coerceEchoedScalar('1.5e+22', 'number')).toBe(1.5e22);
    expect(coerceEchoedScalar('1e-7', 'number')).toBe(1e-7);
  });

  it('leaves every number spelling neither client rule accepts', () => {
    for (const spelling of [
      '1e3', '1E+21', '1e21', '0x10', 'Infinity', '-Infinity', 'NaN', '', ' ', 'abc', '5000 ms',
      '5,000', '5_000', '5.', '.5', '1e', '+', '-', '5 000', '1e+21 ',
    ]) {
      expect(coerceEchoedScalar(spelling, 'number'), JSON.stringify(spelling)).toBe(spelling);
    }
  });

  it('applies the same rule to an integer property, with no integrality check', () => {
    expect(coerceEchoedScalar('5', 'integer')).toBe(5);
    expect(coerceEchoedScalar('-3', 'integer')).toBe(-3);
    expect(coerceEchoedScalar('5.5', 'integer')).toBe(5.5);
    expect(coerceEchoedScalar('5.0', 'integer')).toBe(5);
    expect(coerceEchoedScalar(' 5 ', 'integer')).toBe(5);
    expect(coerceEchoedScalar('1e3', 'integer')).toBe('1e3');
  });

  it('never touches a value that is not a string', () => {
    for (const value of [5000, 0, -0, 5.5, false, true, null, undefined, [], {}, ['5000'], { n: '5000' }]) {
      expect(coerceEchoedScalar(value, 'number')).toBe(value);
      expect(coerceEchoedScalar(value, 'integer')).toBe(value);
      expect(coerceEchoedScalar(value, 'boolean')).toBe(value);
    }
  });

  it('does not cross kinds', () => {
    expect(coerceEchoedScalar('true', 'number')).toBe('true');
    expect(coerceEchoedScalar('5000', 'boolean')).toBe('5000');
    expect(coerceEchoedScalar('[1]', 'number')).toBe('[1]');
    expect(coerceEchoedScalar('{}', 'number')).toBe('{}');
  });
});
