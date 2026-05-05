import { sanitizeLuceneQuery } from '../src/utils/lucene';

describe('sanitizeLuceneQuery', () => {
  it('should escape special characters', () => {
    expect(sanitizeLuceneQuery('hello+world')).toBe('hello\\+world');
    expect(sanitizeLuceneQuery('test*')).toBe('test\\*');
    expect(sanitizeLuceneQuery('foo?bar')).toBe('foo\\?bar');
    expect(sanitizeLuceneQuery('a:b')).toBe('a\\:b');
    expect(sanitizeLuceneQuery('path/to')).toBe('path\\/to');
    expect(sanitizeLuceneQuery('"quoted"')).toBe('\\"quoted\\"');
    expect(sanitizeLuceneQuery('a~b')).toBe('a\\~b');
    expect(sanitizeLuceneQuery('a^b')).toBe('a\\^b');
  });

  it('should not escape regular characters', () => {
    expect(sanitizeLuceneQuery('hello world')).toBe('hello world');
    expect(sanitizeLuceneQuery('albuterol')).toBe('albuterol');
    expect(sanitizeLuceneQuery('abc123')).toBe('abc123');
  });

  it('should handle empty string', () => {
    expect(sanitizeLuceneQuery('')).toBe('');
  });

  it('should handle string with multiple special characters', () => {
    expect(sanitizeLuceneQuery('(a+b)*c')).toBe('\\(a\\+b\\)\\*c');
    // `TO` lowercased to `to` (range operator neutralised). Brackets are
    // already escaped, so the range query was already disarmed; this just
    // makes the bareword side defense-in-depth.
    expect(sanitizeLuceneQuery('[1 TO 5]')).toBe('\\[1 to 5\\]');
    expect(sanitizeLuceneQuery('a && b || c')).toBe('a \\&\\& b \\|\\| c');
  });

  // v1.7.3 — bareword boolean neutralisation
  describe('v1.7.3 — bareword boolean neutralisation', () => {
    it('lowercases standalone uppercase AND', () => {
      expect(sanitizeLuceneQuery('foo AND bar')).toBe('foo and bar');
    });

    it('lowercases standalone uppercase OR', () => {
      expect(sanitizeLuceneQuery('foo OR bar')).toBe('foo or bar');
    });

    it('lowercases standalone uppercase NOT', () => {
      expect(sanitizeLuceneQuery('NOT foo')).toBe('not foo');
    });

    it('does not touch booleans inside other words (word-boundary safe)', () => {
      expect(sanitizeLuceneQuery('BAND STOP NORTH PORTO')).toBe(
        'BAND STOP NORTH PORTO',
      );
    });

    it('neutralises the documented attack vector', () => {
      // Pre-1.7.3 this passed AND through unchanged → boolean injection.
      // Post-1.7.3 the boolean is demoted to literal `and`, the colon
      // (Lucene field-query operator) is escaped. Underscores are not
      // Lucene specials so `_exists_` survives as-is — but without the
      // boolean and without the colon it can no longer form a valid
      // `_exists_:field` query, neutralising the attack.
      const out = sanitizeLuceneQuery('foo AND _exists_:adminFlag');
      expect(out).toBe('foo and _exists_\\:adminFlag');
      expect(out).not.toContain(' AND ');
      expect(out).toContain('\\:');
    });

    it('still handles && / || operator forms correctly', () => {
      // Regression: the placeholder dance must not collide with the
      // bareword pass even when both are present.
      expect(sanitizeLuceneQuery('foo && AND bar')).toBe('foo \\&\\& and bar');
      expect(sanitizeLuceneQuery('foo || OR bar')).toBe('foo \\|\\| or bar');
    });
  });
});
