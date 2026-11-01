import { assertSafeRegexPattern } from '../src/utils/validation';
import { OGMError } from '../src/errors';

const check = (p: string) => assertSafeRegexPattern(p, 'test');

describe('assertSafeRegexPattern — `_MATCHES` ReDoS guard', () => {
  describe('rejects catastrophic-backtracking patterns (soundness)', () => {
    // Every family from the ReDoS literature, plus the exact patterns that
    // slipped past the two earlier heuristic attempts.
    const evil = [
      // nested quantifier over a single atom
      '(a+)+',
      '(a+)+$',
      '(a*)*',
      '(a*)+',
      '(a+)*',
      '(.+)+',
      '(.*)*',
      // nullable body under repeat
      '(a?)+',
      '(a?)+$',
      '(a?)*',
      '(a*b*)*',
      // identical / overlapping alternation branches under repeat
      '(a|a)*',
      '(a|a)+',
      '(a|ab)*',
      '(a|ab)+',
      '(a|aa)*',
      '(a|b|ab)*',
      // custom character class base — the case that defeated attempt #2
      '([a-z]+)+',
      '([a-z]+)+$',
      '([a-z]+)*',
      '([0-9]+)+',
      '([^"]+)+',
      '([\\w]+)+',
      // predefined class base
      '(\\w+)+',
      '(\\d+)+',
      '(\\s+)+',
      '(\\w+)*',
      // nested group base — the other attempt-#2 miss
      '((ab)+)+',
      '((a)+)+',
      '(([a-z])+)+',
      // bounded-but-large repeat of an ambiguous group
      '(.*a){30}',
      '(.*a){10}',
      '(a+){5}',
      // unrolled adjacent optionals (no group at all)
      'a?a?a?a?a?aaaaa',
      'a?a?a?a?a?a?a?a?a?a?aaaaaaaaaa',
      // adjacent unbounded quantifiers over overlapping charsets
      'a+a+',
      'a*a*',
      '.*.*',
      '.+.+',
      '\\w+\\w+',
      '[a-z]+[a-z]+',
      '.*a.*a.*',
      // two loose quantifiers separated only by an overlapping required atom
      'a+aa+',
      'a+.a+',
    ];

    it.each(evil)('rejects %j', (pattern) => {
      expect(() => check(pattern)).toThrow(OGMError);
    });
  });

  describe('rejects constructs it cannot fully model (fail-closed)', () => {
    const unsupported = [
      '(?=foo)', // lookahead
      '(?!foo)', // negative lookahead
      '(?<=foo)', // lookbehind
      '(?<name>a)', // named group
      '(?>a+)', // atomic group
      'a\\1', // backreference
      '(a)\\1', // backreference
      '\\p{L}+', // unicode property
      '[a-z&&[^c]]', // class intersection
      '[[:alpha:]]', // POSIX class (nested [)
      'a\\', // trailing backslash
      '[a-z', // unterminated class
      '(abc', // unbalanced (
      'abc)', // unbalanced )
      'a\\A', // unsupported escape
      '*abc', // quantifier with no atom
    ];

    it.each(unsupported)('rejects %j', (pattern) => {
      expect(() => check(pattern)).toThrow(OGMError);
    });
  });

  describe('accepts patterns provably free of catastrophic backtracking', () => {
    const safe = [
      '',
      'abc',
      '^abc$',
      'foo.*bar',
      '.*foo',
      'foo.*',
      '.*',
      '.+',
      '[a-z]+',
      '[A-Za-z0-9_]+',
      '\\d+',
      '\\w*',
      '\\s+',
      '\\d{3}-\\d{4}',
      'a{2,5}',
      'colou?r',
      '^https?',
      '[a-z]+@[a-z]+\\.[a-z]+', // email-shaped, fenced by @ and .
      '\\d+\\.\\d+\\.\\d+\\.\\d+', // ipv4-shaped, fenced by dots
      '(abc)', // non-quantified group
      '(?:abc)def', // non-quantified non-capturing group
      'a-z', // literal dash
      '\\.\\*\\(', // escaped metacharacters
      '[a-z]+ [0-9]+', // two loose atoms fenced by a required space
      '\\d+[a-z]+', // two loose atoms over disjoint charsets
    ];

    it.each(safe)('accepts %j', (pattern) => {
      expect(() => check(pattern)).not.toThrow();
    });
  });

  describe('conservatively refuses some safe patterns (documented precision cost)', () => {
    // Sound-by-construction means erring toward rejection: these are linear
    // but the guard cannot prove it, so it refuses them. Callers use the
    // dedicated operators (there is no bypass).
    const conservativelyRejected = [
      'foo|bar', // alternation
      '(cat|dog)', // alternation
      '(ab)+', // quantified group of a fixed string (actually linear)
    ];

    it.each(conservativelyRejected)('refuses %j', (pattern) => {
      expect(() => check(pattern)).toThrow(OGMError);
    });

    it('refuses `.*foo.*` without dot-all — it is quadratic, not just unproven', () => {
      // Measured on 5.26: ~9 s on a 100k-char `x…\n`. The dot-all form is
      // accepted (see "dot-all absorbing tail").
      expect(() => check('.*foo.*')).toThrow(OGMError);
    });
  });

  // v2.28.0 — the message used to suggest `features.filters.String.MATCHES`
  // for running "arbitrary regexes"; that flag disables the operator.
  describe('refusal message', () => {
    const message = (p: string): string => {
      try {
        check(p);
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error(`expected ${p} to be refused`);
    };

    it('names the reason, the alternatives and the accepted forms', () => {
      expect(message('(a|b)')).toBe(
        'Unsafe `_MATCHES` pattern in test: alternation (`|`) is not supported. ' +
          'It cannot be proven free of catastrophic backtracking (ReDoS) and is refused; ' +
          'Neo4j cannot interrupt a running regex, so there is no bypass. ' +
          "For substring search use _CONTAINS (with mode: 'insensitive' for case-insensitive), " +
          '_STARTS_WITH, _ENDS_WITH or _IN. Accepted regexes are flat patterns whose ' +
          "variable-length parts cannot compete for the same characters (e.g. '^foo.*bar$'), " +
          "plus the dot-all contains form '(?s).*term.*' / '(?is).*term.*' " +
          '(escape regex metacharacters in an interpolated term with a backslash).',
      );
    });

    it('no longer offers features.filters.String.MATCHES as an escape hatch', () => {
      for (const p of ['(a|b)', '(?i).*x.*', '.*a.*b.*', 'a'.repeat(1001)])
        expect(message(p)).not.toMatch(/features\.filters|accept the risk/);
    });

    it('carries the dot-all hint inside the reason', () => {
      expect(message('(?i).*x.*')).toMatch(
        /^Unsafe `_MATCHES` pattern in test: two variable-length quantifiers can contend over the same input \(did you mean the dot-all form\? Start the pattern with `\(\?s\)`, e\.g\. `\(\?is\)\.\*term\.\*`; it is accepted, and also lets `\.` match line terminators\)\. It cannot be proven/,
      );
    });
  });

  describe('Java-flavor divergences are modeled soundly', () => {
    it('treats `\\v` as the Java vertical-whitespace class (broad), not one char', () => {
      // In Java `\v` includes \n, so `\n*\v*` contends over the newline —
      // quadratic. The guard must not think \n and \v are disjoint.
      expect(() => check('\\n*\\v*!')).toThrow(OGMError);
      expect(() => check('\\r*\\v*!')).toThrow(OGMError);
      expect(() => check('[\\v]*\\n*')).toThrow(OGMError);
      // A lone `\v*` is still fine (a single loose atom cannot contend).
      expect(() => check('\\v*')).not.toThrow();
    });

    it('refuses `\\0` octal escapes (Java reads `\\011` as TAB, inside \\s)', () => {
      expect(() => check('\\s*\\011*')).toThrow(OGMError);
      expect(() => check('\\011*\\011*')).toThrow(OGMError);
      expect(() => check('\\d*\\060*')).toThrow(OGMError);
      expect(() => check('[\\011]*\\s*')).toThrow(OGMError);
      expect(() => check('\\0')).toThrow(OGMError);
    });
  });

  describe('inline flags — supported, and sound under case-folding', () => {
    it.each(['(?i)foo', '(?i)[a-z]+', '(?i)^abc$', '(?s).*', '(?i:abc)def'])(
      'accepts flag pattern %j',
      (pattern) => {
        expect(() => check(pattern)).not.toThrow();
      },
    );

    it('refuses unmodeled flags that change parsing or charsets (fail-closed)', () => {
      // (?x) COMMENTS mode strips whitespace on the server, so `(?x)(a+) +`
      // is the exponential `(a+)+` in Java — the guard must NOT be fooled by
      // the whitespace it sees as a literal fence.
      expect(() => check('(?x)(a+) +')).toThrow(OGMError);
      expect(() => check('(?x)a* a*')).toThrow(OGMError);
      // (?u)/(?U) widen \d\w\s and case-folding beyond the ASCII model.
      expect(() => check('(?u)\\d+')).toThrow(OGMError);
      expect(() => check('(?U)a+')).toThrow(OGMError);
      // A flag group mixing a modeled flag with an unmodeled one is refused.
      expect(() => check('(?ix)foo')).toThrow(OGMError);
    });

    it('rejects a pattern that is catastrophic ONLY under (?i) case-folding', () => {
      // Raw code points make `A+` look like a fence between two `a+`; under
      // (?i) all three match [aA], so this is 3-loose with no fence. The
      // guard must case-fold and reject it.
      expect(() => check('(?i)a+A+a+')).toThrow(OGMError);
      // Without the flag, `A` really is disjoint from `a` — a valid fence.
      expect(() => check('a+A+a+')).not.toThrow();
    });
  });

  // v2.28.0 — issue #2: under a provable DOTALL a trailing `.*` / `.+` is
  // absorbing (it matches any remaining suffix on its first try), so the
  // contains idiom `(?is).*term.*` is linear and accepted. Measured on Neo4j
  // 5.26: `(?is).*x.*` ~5 ms on a 1M-char `x…\n`; `(?i).*x.*` ~9 s at 100k.
  describe('dot-all absorbing tail (contains form)', () => {
    const accepted = [
      '(?s).*x.*',
      '(?is).*x.*',
      '(?si).*abc.*',
      '(?s)^.*x.*$',
      '(?s).*x.*$',
      '(?s).+x.+',
      '(?s).*x.+',
      '(?s).+x.*',
      '(?s).*x.*?',
      '(?s).*x.*+',
      '(?s).*x.+?',
      '(?s)^foo.*bar.*',
      '(?s).*[0-9].*',
      '(?s).*(x).*',
      '(?s)(.*x.*)',
      '(?s)(?:.*x.*)$',
      '(?ism).*x.*',
      '(?sd).*x.*',
      '(?is).*\\(a\\)\\.\\*.*', // a term with escaped metacharacters
      '(?is).*foo bar.*',
      '(?s)(?i).*x.*',
      '(?s)(?i:.*x).*',
    ];

    it.each(accepted)('accepts %j', (pattern) => {
      expect(() => check(pattern)).not.toThrow();
    });

    const stillRefused = [
      // no DOTALL: `.` stops at a line terminator, so the tail can fail
      '(?i).*x.*',
      '.*x.*',
      '.+x.+',
      '^.*x.*$',
      // a literal after the last wildcard — not absorbing (measured n²)
      '(?s).*x.*y',
      '(?s).*foo.*bar',
      '(?s).*x.*?y',
      // more than one gap left after trimming the tail
      '(?s).*a.*b.*',
      '(?s).*aa.*aa.*',
      '(?s).*a.*b.*c.*',
      '(?s).*x.*.*', // only the last atom is a tail
      // the remainder must still pass on its own
      '(?s).*a+.*',
      '(?s)(a+)+.*',
      '(?s).*(a|b).*',
      // the tail must be a bare `.` with an unbounded max and min <= 1
      '(?s).*x.{2,}',
      '(?s).*x.{0,5}.*x.{0,5}',
      '(?s).*x[^y]*',
      '(?s).*x\\S*',
      // a zero-width assertion after the tail can fail
      '(?s).*x.*\\b',
      '(?s).*x.*\\B',
    ];

    it.each(stillRefused)('still refuses %j', (pattern) => {
      expect(() => check(pattern)).toThrow(OGMError);
    });

    describe('DOTALL is honoured only when provable (flag scoping, fail-closed)', () => {
      const notDotAll = [
        '(?-s).*x.*', // turned off
        '(?s-i).*x.*', // any `-` disables the rule
        '(?s)(?-s).*x.*', // turned back off later
        '(?s)(?i-s:.*x.*)',
        '(?s)(?-s:.*x).*',
        '(?s)x(?-i).*x.*',
        '^(?s).*x.*', // not the first token
        'x(?s).*y.*', // not at the start
        '(?i)(?s).*x.*', // only the opening group counts
        '(?s:.*x.*)', // scoped, not zero-width
        '(?i)(?s:.*x).*', // tail outside the scoped group
        '(?x s).*x.*', // unmodeled flag — refused outright
        '(?su).*x.*',
      ];

      it.each(notDotAll)('refuses %j', (pattern) => {
        expect(() => check(pattern)).toThrow(OGMError);
      });
    });

    it('hints at the dot-all form when it would be accepted', () => {
      expect(() => check('(?i).*x.*')).toThrow(/did you mean the dot-all form/);
      expect(() => check('.+abc.+')).toThrow(/did you mean the dot-all form/);
      expect(() => check('.*x.*$')).toThrow(/Start the pattern with `\(\?s\)`/);
    });

    it('does not hint when the dot-all form would be refused too', () => {
      for (const p of ['.*a.*b.*', '.*x.*y', '(?-s).*x.*', 'a+a+', '(a+)+'])
        expect(() => check(p)).toThrow(OGMError);
      for (const p of ['.*a.*b.*', '.*x.*y', '(?-s).*x.*', 'a+a+'])
        expect(() => check(p)).not.toThrow(/did you mean the dot-all form/);
    });
  });

  describe('bounds its own work (cannot be a DoS vector)', () => {
    it('rejects an over-length pattern in O(1) before parsing', () => {
      expect(() => check('a'.repeat(1001))).toThrow(/exceeds/);
    });

    it('accepts a benign pattern at the atom cap', () => {
      expect(() => check('a'.repeat(256))).not.toThrow();
    });

    it('refuses a pattern exceeding the atom cap', () => {
      expect(() => check('a'.repeat(300))).toThrow(/many components/);
    });

    it('handles a pathological under-cap input without hanging', () => {
      // 500 adjacent optionals — quadratic pair-checking at worst, bounded.
      expect(() => check('a?'.repeat(500))).toThrow(OGMError);
    });

    it('rejects a huge input immediately via the length cap', () => {
      expect(() => check('('.repeat(100000))).toThrow(/exceeds/);
    });
  });
});
