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
    expect(sanitizeLuceneQuery('[1 TO 5]')).toBe('\\[1 TO 5\\]');
    expect(sanitizeLuceneQuery('a && b || c')).toBe('a \\&\\& b \\|\\| c');
  });
});
