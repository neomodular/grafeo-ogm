import { OGMError } from '../../src/errors';
import { override, permissive, restrictive } from '../../src/policy/types';

describe('policy/types — constructors', () => {
  describe('override()', () => {
    it('returns a frozen object with kind="override"', () => {
      const p = override({
        operations: ['read'],
        when: () => true,
      });
      expect(p.kind).toBe('override');
      expect(Object.isFrozen(p)).toBe(true);
    });

    it('preserves the operations array', () => {
      const p = override({
        operations: ['read', 'update'],
        when: () => false,
      });
      expect(p.operations).toEqual(['read', 'update']);
    });

    it('throws when operations is empty', () => {
      expect(() =>
        override({
          operations: [],
          when: () => true,
        }),
      ).toThrow(OGMError);
    });

    it('throws when operations contains an invalid token', () => {
      expect(() =>
        override({
          // @ts-expect-error — exercising runtime validation.
          operations: ['notAnOp'],
          when: () => true,
        }),
      ).toThrow(/invalid operation/);
    });

    it('accepts wildcard operation', () => {
      const p = override({
        operations: ['*'],
        when: () => true,
      });
      expect(p.operations).toEqual(['*']);
    });

    it('throws when when is not a function', () => {
      expect(() =>
        // @ts-expect-error — runtime validation.
        override({ operations: ['read'], when: 'not a function' }),
      ).toThrow(/must be a function/);
    });

    it('exposes the optional name', () => {
      const p = override({
        operations: ['read'],
        when: () => true,
        name: 'admin-bypass',
      });
      expect(p.name).toBe('admin-bypass');
    });
  });

  describe('permissive()', () => {
    it('returns a frozen object with kind="permissive"', () => {
      const p = permissive({
        operations: ['read'],
        when: () => ({ id: 'x' }),
      });
      expect(p.kind).toBe('permissive');
      expect(Object.isFrozen(p)).toBe(true);
    });

    it('throws when both when and cypher are missing', () => {
      expect(() =>
        permissive({
          operations: ['read'],
        }),
      ).toThrow(/at least one of "when" or "cypher"/);
    });

    it('accepts cypher escape hatch alone', () => {
      const p = permissive({
        operations: ['read'],
        cypher: {
          fragment: () => '$tier IN tiers',
          params: () => ({ tier: 1 }),
        },
      });
      expect(p.cypher).toBeDefined();
    });

    it('throws when cypher.fragment is not a function', () => {
      expect(() =>
        permissive({
          operations: ['read'],
          // @ts-expect-error — runtime validation.
          cypher: { fragment: 'no', params: () => ({}) },
        }),
      ).toThrow(/cypher.fragment/);
    });

    it('throws when cypher.params is not a function', () => {
      expect(() =>
        permissive({
          operations: ['read'],
          // @ts-expect-error — runtime validation.
          cypher: { fragment: () => '', params: 'no' },
        }),
      ).toThrow(/cypher.params/);
    });

    it('preserves appliesWhen when provided', () => {
      const p = permissive({
        operations: ['read'],
        appliesWhen: (c) => Boolean((c as { admin?: boolean }).admin),
        when: () => ({}),
      });
      expect(typeof p.appliesWhen).toBe('function');
    });
  });

  describe('restrictive()', () => {
    it('returns a frozen object with kind="restrictive"', () => {
      const p = restrictive({
        operations: ['read'],
        when: () => ({ tenantId: 't' }),
      });
      expect(p.kind).toBe('restrictive');
      expect(Object.isFrozen(p)).toBe(true);
    });

    it('throws when both when and cypher are missing', () => {
      expect(() =>
        restrictive({
          operations: ['read'],
        }),
      ).toThrow(/at least one of "when" or "cypher"/);
    });

    it('throws when operations is empty', () => {
      expect(() =>
        restrictive({
          operations: [],
          when: () => ({}),
        }),
      ).toThrow(OGMError);
    });

    it('accepts a (ctx, input) signature for create policies', () => {
      const p = restrictive({
        operations: ['create'],
        when: (ctx, input) => Boolean(input && (ctx as { id?: string }).id),
      });
      expect(p.kind).toBe('restrictive');
    });

    // ---- C1 fix: read/write restrictive split ----------------------------
    // The discriminated union has two flavors keyed on `operations`:
    //  - read-side: read|delete|aggregate|count → `when: (ctx) => W|boolean`
    //  - write-side: create|update              → `when: (ctx, input) => boolean`
    // Mixing the two in one `operations` array is a runtime error AND a
    // compile-time error (no overload matches a mixed-shape signature).

    describe('read/write split', () => {
      it('read-side restrictive accepts a (ctx) => W signature', () => {
        const p = restrictive({
          operations: ['read'],
          when: () => ({ tenantId: 't' }),
        });
        expect(p.kind).toBe('restrictive');
        expect(p.operations).toEqual(['read']);
      });

      it('read-side restrictive accepts a (ctx) => boolean signature', () => {
        const p = restrictive({
          operations: ['read'],
          when: () => false,
        });
        expect(p.kind).toBe('restrictive');
      });

      it('write-side restrictive requires a (ctx, input) => boolean signature', () => {
        const p = restrictive({
          operations: ['create'],
          when: (_ctx, _input) => true,
        });
        expect(p.kind).toBe('restrictive');
        expect(p.operations).toEqual(['create']);
      });

      it('write-side restrictive rejects a where-partial return at compile time', () => {
        restrictive({
          operations: ['update'],
          // @ts-expect-error — write restrictives must return boolean (not a where-partial).
          when: (_ctx, _input) => ({ tenantId: 't' }),
        });
      });

      it('write-side restrictive rejects the cypher escape hatch at compile time', () => {
        // The TS overload disallows `cypher` on a write-restrictive
        // (the field doesn't exist on WriteRestrictivePolicy). The
        // runtime guard ALSO throws — defense in depth. We catch
        // here to keep the test green while still asserting the
        // type-level error via @ts-expect-error.
        expect(() =>
          // @ts-expect-error — `cypher` does not exist on WriteRestrictivePolicy.
          restrictive({
            operations: ['create'],
            when: () => true,
            cypher: { fragment: () => '', params: () => ({}) },
          }),
        ).toThrow(/cypher escape hatch is not supported/);
      });

      it('write-side restrictive rejects a single-arg `when` at compile time', () => {
        restrictive({
          operations: ['update'],
          // The single-arg form happens to be assignable to the
          // (ctx, input) => boolean shape because TS is contravariant
          // in parameter count. The runtime contract guarantees `input`
          // is always passed; we assert that below.
          when: (_ctx) => true,
        });
      });

      it('throws at runtime on mixed read+write operations', () => {
        expect(() =>
          // @ts-expect-error — discriminated union catches mixed ops at compile time.
          restrictive({
            operations: ['read', 'create'],
            when: () => true,
          }),
        ).toThrow(/mixes read-side .* and write-side/);
      });

      it('throws at runtime on mixed update+delete operations', () => {
        expect(() =>
          // @ts-expect-error — discriminated union catches mixed ops at compile time.
          restrictive({
            operations: ['update', 'delete'],
            when: () => true,
          }),
        ).toThrow(/mixes read-side .* and write-side/);
      });

      it('throws at runtime on wildcard "*" operations', () => {
        // The TS overloads reject `'*'` on restrictive at compile time,
        // so we cast through `unknown` to exercise the runtime guard
        // (defense in depth for users who bypass the type system).
        const spec = {
          operations: ['*'],
          when: () => true,
        } as unknown as Parameters<typeof restrictive>[0];
        expect(() => restrictive(spec)).toThrow(/wildcard/);
      });

      it('write-side restrictive forbids the cypher escape hatch at runtime', () => {
        // TS rejects `cypher` on WriteRestrictivePolicy (the field
        // doesn't exist on that union arm). Cast to exercise the
        // runtime guard.
        const spec = {
          operations: ['create' as const],
          when: () => true,
          cypher: { fragment: () => '', params: () => ({}) },
        } as unknown as Parameters<typeof restrictive>[0];
        expect(() => restrictive(spec)).toThrow(
          /cypher escape hatch is not supported/,
        );
      });
    });
  });
});
