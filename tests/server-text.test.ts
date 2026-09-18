import { describe, expect, it } from 'vitest';
import { hasControlChars, printableServerText } from '../src/registry/server-text.js';

const char = (code: number): string => String.fromCharCode(code);

describe('hasControlChars', () => {
  it.each([0x00, 0x09, 0x0a, 0x1b, 0x1f, 0x7f, 0x80, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f])(
    'flags code %i inside a string',
    code => {
      expect(hasControlChars(`a${char(code)}b`)).toBe(true);
    },
  );

  it.each([0x20, 0x41, 0x7e, 0xa0])('does not flag code %i', code => {
    expect(hasControlChars(`a${char(code)}b`)).toBe(false);
  });

  it('flags the first or the last character too', () => {
    expect(hasControlChars(`${char(0x1b)}abc`)).toBe(true);
    expect(hasControlChars(`abc${char(0x7f)}`)).toBe(true);
  });

  // Deliberate limit, not an oversight: these cannot move a cursor, clear a
  // screen or set a title. They can only mislead a label, which this check does
  // not claim to stop.
  it.each([0x2028, 0x200b, 0x202e, 0xfeff])('leaves display-only code %i alone', code => {
    expect(hasControlChars(`a${char(code)}b`)).toBe(false);
  });
});

describe('printableServerText', () => {
  it('turns each control character into one space and trims the ends', () => {
    const ESC = char(0x1b);
    const BEL = char(0x07);
    expect(printableServerText(`${ESC}[2J${ESC}]0;X${BEL}hello`)).toBe('[2J ]0;X hello');
    expect(printableServerText(`a${ESC}b`)).toBe('a b');
  });

  it('is empty when the text is only control characters', () => {
    expect(printableServerText(`${char(0x1b)}${char(0x9b)}${char(0x7f)}`)).toBe('');
  });

  it('leaves ordinary text and non-BMP characters untouched', () => {
    const grin = String.fromCodePoint(0x1f600);
    expect(printableServerText(`Provider returned HTTP 500 ${grin}`)).toBe(`Provider returned HTTP 500 ${grin}`);
  });
});
