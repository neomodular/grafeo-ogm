import {
  override,
  permissive,
  restrictive,
  type Policy,
} from '../../src/policy/types';
import { hashCtx, PolicyResolver } from '../../src/policy/resolver';
import type {
  InterfaceDefinition,
  NodeDefinition,
  SchemaMetadata,
} from '../../src/schema/types';

function makeSchema(args?: {
  nodes?: Array<{ typeName: string; implementsInterfaces?: string[] }>;
  interfaces?: Array<{ name: string; implementedBy: string[] }>;
}): SchemaMetadata {
  const nodes = new Map<string, NodeDefinition>();
  for (const n of args?.nodes ?? [])
    nodes.set(n.typeName, {
      typeName: n.typeName,
      label: n.typeName,
      labels: [n.typeName],
      pluralName: n.typeName.toLowerCase() + 's',
      properties: new Map(),
      relationships: new Map(),
      fulltextIndexes: [],
      implementsInterfaces: n.implementsInterfaces ?? [],
    });
  const interfaces = new Map<string, InterfaceDefinition>();
  for (const i of args?.interfaces ?? [])
    interfaces.set(i.name, {
      name: i.name,
      label: i.name,
      properties: new Map(),
      relationships: new Map(),
      implementedBy: i.implementedBy,
    });
  return {
    nodes,
    interfaces,
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
  };
}

function buildResolver(
  policiesByType: Record<string, ReadonlyArray<Policy>>,
  schema: SchemaMetadata,
): PolicyResolver {
  const map = new Map<string, ReadonlyArray<Policy>>();
  for (const [k, v] of Object.entries(policiesByType)) map.set(k, v);
  return new PolicyResolver(map, schema);
}

describe('PolicyResolver', () => {
  it('returns null when no policies are registered for the type', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver({}, schema);
    expect(r.resolve('Book', 'read', {})).toBeNull();
  });

  it('hasAny is false on an empty registry', () => {
    const schema = makeSchema();
    const r = buildResolver({}, schema);
    expect(r.hasAny()).toBe(false);
  });

  it('hasAny is true when any type has policies', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
      schema,
    );
    expect(r.hasAny()).toBe(true);
  });

  it('filters policies by operation', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          permissive({ operations: ['create'], when: () => ({}) }),
          restrictive({ operations: ['read'], when: () => ({}) }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.permissives).toHaveLength(0);
    expect(resolved.restrictives).toHaveLength(1);
  });

  it('matches wildcard operation', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [permissive({ operations: ['*'], when: () => ({}) })],
      },
      schema,
    );
    expect(r.resolve('Book', 'read', {})!.permissives).toHaveLength(1);
    expect(r.resolve('Book', 'create', {})!.permissives).toHaveLength(1);
    expect(r.resolve('Book', 'delete', {})!.permissives).toHaveLength(1);
  });

  it('short-circuits to overridden when an override matches', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          override({
            operations: ['read'],
            when: () => true,
            name: 'admin',
          }),
          permissive({ operations: ['read'], when: () => ({}) }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.overridden).toBe(true);
    expect(resolved.permissives).toHaveLength(0);
    expect(resolved.restrictives).toHaveLength(0);
    expect(resolved.evaluated).toEqual(['admin']);
  });

  it('does not short-circuit when override is for a different op', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          override({ operations: ['create'], when: () => true }),
          permissive({ operations: ['read'], when: () => ({}) }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.overridden).toBe(false);
    expect(resolved.permissives).toHaveLength(1);
  });

  it('does not short-circuit when override.when returns false', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          override({ operations: ['read'], when: () => false }),
          permissive({ operations: ['read'], when: () => ({}) }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.overridden).toBe(false);
    expect(resolved.permissives).toHaveLength(1);
  });

  it('first matching override wins', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          override({ operations: ['read'], when: () => false, name: 'a' }),
          override({ operations: ['read'], when: () => true, name: 'b' }),
        ],
      },
      schema,
    );
    expect(r.resolve('Book', 'read', {})!.evaluated).toEqual(['b']);
  });

  it('drops permissives whose appliesWhen returns false', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          permissive({
            operations: ['read'],
            appliesWhen: () => false,
            when: () => ({}),
          }),
          permissive({
            operations: ['read'],
            when: () => ({ id: 'x' }),
          }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.permissives).toHaveLength(1);
  });

  it('keeps permissives when appliesWhen is undefined (default true)', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
      schema,
    );
    expect(r.resolve('Book', 'read', {})!.permissives).toHaveLength(1);
  });

  it('keeps restrictives unconditionally (no appliesWhen)', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [restrictive({ operations: ['read'], when: () => ({}) })],
      },
      schema,
    );
    expect(r.resolve('Book', 'read', {})!.restrictives).toHaveLength(1);
  });

  it('inherits interface policies onto a concrete type', () => {
    const schema = makeSchema({
      nodes: [{ typeName: 'Book', implementsInterfaces: ['Resource'] }],
      interfaces: [{ name: 'Resource', implementedBy: ['Book'] }],
    });
    const r = buildResolver(
      {
        Resource: [
          restrictive({ operations: ['read'], when: () => ({ tenant: 't' }) }),
        ],
      },
      schema,
    );
    expect(r.resolve('Book', 'read', {})!.restrictives).toHaveLength(1);
  });

  it('combines interface and concrete policies (AND-restrictive, OR-permissive)', () => {
    const schema = makeSchema({
      nodes: [{ typeName: 'Book', implementsInterfaces: ['Resource'] }],
      interfaces: [{ name: 'Resource', implementedBy: ['Book'] }],
    });
    const r = buildResolver(
      {
        Resource: [
          restrictive({
            operations: ['read'],
            when: () => ({ tenantId: 't' }),
          }),
          permissive({ operations: ['read'], when: () => ({ a: 1 }) }),
        ],
        Book: [
          restrictive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
          permissive({ operations: ['read'], when: () => ({ b: 2 }) }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.restrictives).toHaveLength(2);
    expect(resolved.permissives).toHaveLength(2);
  });

  it('override on concrete type bypasses inherited interface policies', () => {
    const schema = makeSchema({
      nodes: [{ typeName: 'Book', implementsInterfaces: ['Resource'] }],
      interfaces: [{ name: 'Resource', implementedBy: ['Book'] }],
    });
    const r = buildResolver(
      {
        Resource: [
          restrictive({
            operations: ['read'],
            when: () => ({ tenantId: 't' }),
          }),
        ],
        Book: [override({ operations: ['read'], when: () => true })],
      },
      schema,
    );
    expect(r.resolve('Book', 'read', {})!.overridden).toBe(true);
  });

  it('returns null when matching list is empty after op filter', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [permissive({ operations: ['create'], when: () => ({}) })],
      },
      schema,
    );
    expect(r.resolve('Book', 'read', {})).toBeNull();
  });

  it('records evaluated policy names', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({}),
            name: 'p1',
          }),
          restrictive({
            operations: ['read'],
            when: () => ({}),
            name: 'r1',
          }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.evaluated).toEqual(['p1', 'r1']);
  });

  it('uses default policy names when none provided', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({ operations: ['read'], when: () => ({}) }),
        ],
      },
      schema,
    );
    expect(r.resolve('Book', 'read', {})!.evaluated).toEqual([
      'permissive',
      'restrictive',
    ]);
  });

  it('passes ctx into appliesWhen', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const seen: unknown[] = [];
    const r = buildResolver(
      {
        Book: [
          permissive({
            operations: ['read'],
            appliesWhen: (c) => {
              seen.push(c);
              return true;
            },
            when: () => ({}),
          }),
        ],
      },
      schema,
    );
    r.resolve('Book', 'read', { uid: 'u1' });
    expect(seen).toEqual([{ uid: 'u1' }]);
  });

  it('passes ctx into override.when', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    let captured: unknown;
    const r = buildResolver(
      {
        Book: [
          override({
            operations: ['read'],
            when: (c) => {
              captured = c;
              return true;
            },
          }),
        ],
      },
      schema,
    );
    r.resolve('Book', 'read', { admin: true });
    expect(captured).toEqual({ admin: true });
  });

  it('handles a type unknown to the schema gracefully', () => {
    const schema = makeSchema();
    const r = buildResolver(
      { Mystery: [permissive({ operations: ['read'], when: () => ({}) })] },
      schema,
    );
    expect(r.resolve('Mystery', 'read', {})!.permissives).toHaveLength(1);
  });

  it('returns evaluated of length 1 with override name', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [override({ operations: ['read'], when: () => true })],
      },
      schema,
    );
    expect(r.resolve('Book', 'read', {})!.evaluated).toEqual(['override']);
  });

  it('handles multiple permissives and multiple restrictives', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          permissive({ operations: ['read'], when: () => ({}) }),
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({ operations: ['read'], when: () => ({}) }),
          restrictive({ operations: ['read'], when: () => ({}) }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.permissives).toHaveLength(2);
    expect(resolved.restrictives).toHaveLength(2);
  });

  it('mixed with override (false) keeps the rest', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [
          override({ operations: ['read'], when: () => false }),
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({ operations: ['read'], when: () => ({}) }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.overridden).toBe(false);
    expect(resolved.permissives).toHaveLength(1);
    expect(resolved.restrictives).toHaveLength(1);
  });

  it('aggregate falls back independently — no implicit "read" usage in resolver', () => {
    const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });
    const r = buildResolver(
      {
        Book: [permissive({ operations: ['read'], when: () => ({}) })],
      },
      schema,
    );
    // Resolver alone doesn't fall back; the model layer chooses the op.
    expect(r.resolve('Book', 'aggregate', {})).toBeNull();
  });
});

describe('PolicyResolver.resolveDetailed', () => {
  const schema = makeSchema({
    nodes: [{ typeName: 'Book', implementsInterfaces: ['Resource'] }],
    interfaces: [{ name: 'Resource', implementedBy: ['Book'] }],
  });

  it('returns null exactly when resolve() does', () => {
    const r = buildResolver(
      { Book: [permissive({ operations: ['create'], when: () => ({}) })] },
      schema,
    );
    expect(r.resolveDetailed('Book', 'read', {})).toBeNull();
    expect(r.resolve('Book', 'read', {})).toBeNull();
    expect(buildResolver({}, schema).resolveDetailed('Book', 'read', {})).toBe(
      null,
    );
  });

  it('reports every matching policy in registration order: own type, then interfaces', () => {
    const r = buildResolver(
      {
        Book: [
          permissive({ operations: ['read'], when: () => ({}), name: 'p' }),
          restrictive({ operations: ['read'], when: () => ({}), name: 'r' }),
        ],
        Resource: [
          restrictive({ operations: ['read'], when: () => ({}), name: 'ri' }),
        ],
      },
      schema,
    );
    const d = r.resolveDetailed('Book', 'read', {})!;
    expect(d.overriddenBy).toBeNull();
    expect(
      d.entries.map((e) => [e.name, e.kind, e.source, e.index, e.applied]),
    ).toEqual([
      ['p', 'permissive', 'Book', 0, true],
      ['r', 'restrictive', 'Book', 1, true],
      ['ri', 'restrictive', 'Resource', 0, true],
    ]);
  });

  it('synthesizes <source>.<kind>[<index>] ids for unnamed policies, counting all operations', () => {
    const r = buildResolver(
      {
        Book: [
          permissive({ operations: ['create'], when: () => ({}) }),
          permissive({ operations: ['read'], when: () => ({}) }),
          restrictive({ operations: ['read'], when: () => ({}), name: 'r' }),
        ],
        Resource: [restrictive({ operations: ['read'], when: () => ({}) })],
      },
      schema,
    );
    const d = r.resolveDetailed('Book', 'read', {})!;
    expect(d.entries.map((e) => [e.name, e.named])).toEqual([
      ['Book.permissive[1]', false],
      ['r', true],
      ['Resource.restrictive[0]', false],
    ]);
  });

  it('keeps duplicate names as separate positional entries', () => {
    const r = buildResolver(
      {
        Book: [
          restrictive({ operations: ['read'], when: () => ({}), name: 'dup' }),
          restrictive({ operations: ['read'], when: () => ({}), name: 'dup' }),
        ],
      },
      schema,
    );
    const d = r.resolveDetailed('Book', 'read', {})!;
    expect(d.entries.map((e) => [e.name, e.index])).toEqual([
      ['dup', 0],
      ['dup', 1],
    ]);
  });

  it('evaluates appliesWhen for BOTH permissives and restrictives', () => {
    const r = buildResolver(
      {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({}),
            name: 'p-off',
            appliesWhen: () => false,
          }),
          restrictive({
            operations: ['read'],
            when: () => ({}),
            name: 'r-off',
            appliesWhen: () => false,
          }),
          restrictive({
            operations: ['read'],
            when: () => ({}),
            name: 'r-on',
            appliesWhen: () => true,
          }),
        ],
      },
      schema,
    );
    const d = r.resolveDetailed('Book', 'read', {})!;
    expect(d.entries.map((e) => [e.name, e.applied, e.skipped])).toEqual([
      ['p-off', false, false],
      ['r-off', false, false],
      ['r-on', true, false],
    ]);
  });

  it('marks everything after a firing override (and every non-override) as skipped', () => {
    const seen: string[] = [];
    const r = buildResolver(
      {
        Book: [
          permissive({
            operations: ['read'],
            when: () => ({}),
            name: 'p',
            appliesWhen: () => {
              seen.push('p.appliesWhen');
              return true;
            },
          }),
          override({ operations: ['read'], when: () => false, name: 'o1' }),
          override({ operations: ['read'], when: () => true, name: 'o2' }),
          override({
            operations: ['read'],
            when: () => {
              seen.push('o3.when');
              return true;
            },
            name: 'o3',
          }),
        ],
      },
      schema,
    );
    const d = r.resolveDetailed('Book', 'read', {})!;
    expect(d.overriddenBy).toBe('o2');
    expect(d.entries.map((e) => [e.name, e.applied, e.skipped])).toEqual([
      ['p', false, true],
      ['o1', false, false],
      ['o2', true, false],
      ['o3', false, true],
    ]);
    // Short-circuit is real: nothing after the firing override runs, and
    // no appliesWhen runs at all.
    expect(seen).toEqual([]);
  });

  it('reports a non-firing override as not applied', () => {
    const r = buildResolver(
      {
        Book: [
          override({ operations: ['read'], when: () => false, name: 'o' }),
          permissive({ operations: ['read'], when: () => ({}), name: 'p' }),
        ],
      },
      schema,
    );
    const d = r.resolveDetailed('Book', 'read', {})!;
    expect(d.overriddenBy).toBeNull();
    expect(d.entries.map((e) => [e.name, e.applied, e.skipped])).toEqual([
      ['o', false, false],
      ['p', true, false],
    ]);
  });

  it('uses the fallback id for an unnamed firing override', () => {
    const r = buildResolver(
      { Book: [override({ operations: ['read'], when: () => true })] },
      schema,
    );
    expect(r.resolveDetailed('Book', 'read', {})!.overriddenBy).toBe(
      'Book.override[0]',
    );
    // resolve() keeps its legacy audit name.
    expect(r.resolve('Book', 'read', {})!.evaluated).toEqual(['override']);
  });
});

describe('PolicyResolver.resolve — appliesWhen on restrictives', () => {
  const schema = makeSchema({ nodes: [{ typeName: 'Book' }] });

  it('omits a non-applying restrictive from `evaluated` but keeps it in `restrictives`', () => {
    const rOff = restrictive({
      operations: ['read'],
      when: () => ({}),
      name: 'r-off',
      appliesWhen: () => false,
    });
    const rOn = restrictive({
      operations: ['read'],
      when: () => ({}),
      name: 'r-on',
    });
    const r = buildResolver(
      {
        Book: [
          permissive({ operations: ['read'], when: () => ({}), name: 'p' }),
          rOff,
          rOn,
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'read', {})!;
    expect(resolved.evaluated).toEqual(['p', 'r-on']);
    // Downstream (compiler / evaluateWriteRestrictives) still enforces the
    // gate; the array itself is unchanged so InterfaceModel's
    // "no policies → unconstrained" branch cannot be reached by gating.
    expect(resolved.restrictives).toEqual([rOff, rOn]);
  });

  it('applies the same audit rule to write-side restrictives', () => {
    const r = buildResolver(
      {
        Book: [
          permissive({ operations: ['update'], when: () => ({}), name: 'p' }),
          restrictive({
            operations: ['update'],
            when: () => true,
            name: 'w-off',
            appliesWhen: () => false,
          }),
        ],
      },
      schema,
    );
    const resolved = r.resolve('Book', 'update', {})!;
    expect(resolved.evaluated).toEqual(['p']);
    expect(resolved.restrictives).toHaveLength(1);
  });
});

describe('hashCtx', () => {
  it('returns "empty" for undefined or null', () => {
    expect(hashCtx(undefined)).toBe('empty');
  });

  it('returns the same hash for the same key shape regardless of values', () => {
    const a = hashCtx({ uid: 'u1', tenant: 't1' });
    const b = hashCtx({ uid: 'u2', tenant: 't9' });
    expect(a).toBe(b);
  });

  it('returns different hashes for different key shapes', () => {
    const a = hashCtx({ uid: 'u1' });
    const b = hashCtx({ uid: 'u1', tenant: 't1' });
    expect(a).not.toBe(b);
  });

  it('is order-independent', () => {
    const a = hashCtx({ a: 1, b: 2 });
    const b = hashCtx({ b: 2, a: 1 });
    expect(a).toBe(b);
  });

  it('returns 16 hex chars', () => {
    const h = hashCtx({ uid: 'u' });
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
