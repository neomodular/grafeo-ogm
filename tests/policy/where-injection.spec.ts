import { WhereCompiler } from '../../src/compilers/where.compiler';
import {
  override,
  permissive,
  restrictive,
  type PolicyContextBundle,
  type ResolvedPolicies,
} from '../../src/policy/types';
import type {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../../src/schema/types';

function prop(
  over: Partial<PropertyDefinition> & { name: string },
): PropertyDefinition {
  return {
    type: 'String',
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: false,
    directives: [],
    ...over,
  };
}

function makeNodeDef(
  over: Partial<NodeDefinition> & { typeName: string },
): NodeDefinition {
  return {
    label: over.typeName,
    labels: [over.typeName],
    pluralName: over.typeName.toLowerCase() + 's',
    properties: new Map(),
    relationships: new Map(),
    fulltextIndexes: [],
    implementsInterfaces: [],
    ...over,
  };
}

const tierNode = makeNodeDef({
  typeName: 'Tier',
  properties: new Map([['id', prop({ name: 'id' })]]),
});
const bookNode = makeNodeDef({
  typeName: 'Book',
  properties: new Map<string, PropertyDefinition>([
    ['id', prop({ name: 'id' })],
    ['ownerId', prop({ name: 'ownerId' })],
    ['tenantId', prop({ name: 'tenantId' })],
    ['published', prop({ name: 'published', type: 'Boolean' })],
  ]),
  relationships: new Map<string, RelationshipDefinition>([
    [
      'tiers',
      {
        fieldName: 'tiers',
        type: 'HAS_TIER',
        direction: 'OUT',
        target: 'Tier',
        isArray: true,
        isRequired: false,
      },
    ],
  ]),
});

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Book', bookNode],
    ['Tier', tierNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

function bundle(
  overrides: Partial<ResolvedPolicies>,
  ctx: Record<string, unknown> = {},
  defaults: PolicyContextBundle['defaults'] = { onDeny: 'empty' },
): PolicyContextBundle {
  return {
    ctx,
    operation: 'read',
    resolved: {
      overridden: false,
      permissives: [],
      restrictives: [],
      evaluated: [],
      ...overrides,
    },
    resolveForType: () => null,
    defaults,
  };
}

describe('WhereCompiler — policy AND-stitching', () => {
  let compiler: WhereCompiler;

  beforeEach(() => {
    compiler = new WhereCompiler(schema);
  });

  it('AND-stitches a single permissive into the user where', () => {
    const ctx = { ownerId: 'u1' };
    const policyContext = bundle(
      {
        permissives: [
          permissive({
            operations: ['read'],
            when: (c) => ({ ownerId: (c as typeof ctx).ownerId }),
          }),
        ],
      },
      ctx,
    );
    const result = compiler.compile(
      { id: 'b1' },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain('AND');
    expect(result.cypher).toContain('n.`ownerId`');
  });

  it('emits OR between two permissives', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'a' }) }),
        permissive({ operations: ['read'], when: () => ({ tenantId: 't' }) }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain(' OR ');
  });

  it('emits AND between restrictives', () => {
    const policyContext = bundle({
      permissives: [permissive({ operations: ['read'], when: () => ({}) })],
      restrictives: [
        restrictive({ operations: ['read'], when: () => ({ tenantId: 't1' }) }),
        restrictive({
          operations: ['read'],
          when: () => ({ published: true }),
        }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    // Permissives + restrictives → policyClause is `(perm AND rest)`.
    expect(result.cypher).toContain('AND');
    expect(result.cypher).toContain('n.`tenantId`');
    expect(result.cypher).toContain('n.`published`');
  });

  it('combines permissives and restrictives as ((p) AND r)', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
      ],
      restrictives: [
        restrictive({ operations: ['read'], when: () => ({ tenantId: 't' }) }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toMatch(/n\.`ownerId` = .* AND .*n\.`tenantId`/);
  });

  it('emits WHERE false when no permissives matched and onDeny is empty', () => {
    const policyContext = bundle(
      {
        permissives: [],
        restrictives: [],
      },
      {},
    );
    // Pass undefined where to force a "matching set non-empty but
    // contributed nothing" path. Policy context is already empty so
    // the bundle would be filtered out by the model layer; we exercise
    // the resolver-level "permissives empty" deny rule.
    policyContext.resolved = {
      overridden: false,
      permissives: [],
      restrictives: [
        restrictive({ operations: ['read'], when: () => ({ tenantId: 't' }) }),
      ],
      evaluated: [],
    };
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toBe('false');
  });

  it('overridden bundle is byte-identical to no-policy emission', () => {
    const policyContext = bundle({ overridden: true });
    const result = compiler.compile(
      { id: 'b1' },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    const baseline = compiler.compile({ id: 'b1' }, 'n', bookNode, {
      count: 0,
    });
    expect(result.cypher).toBe(baseline.cypher);
    expect(result.params).toEqual(baseline.params);
  });

  it('empty user where + policy → emits only the policy', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain('n.`ownerId`');
    expect(result.cypher).not.toContain('id');
  });

  it('threads paramCounter so user and policy params do not collide', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
      ],
    });
    const result = compiler.compile(
      { id: 'b1' },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    const keys = Object.keys(result.params);
    expect(keys).toEqual(expect.arrayContaining(['param0', 'param1']));
  });

  it('relationship traversal in policy where compiles via existing quantifier logic', () => {
    const policyContext = bundle({
      permissives: [
        permissive({
          operations: ['read'],
          when: () => ({ tiers_SOME: { id: 'free' } }),
        }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain('EXISTS');
  });

  it('AND/OR logical operators inside policy work', () => {
    const policyContext = bundle({
      permissives: [
        permissive({
          operations: ['read'],
          when: () => ({ AND: [{ ownerId: 'u' }, { tenantId: 't' }] }),
        }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain(' AND ');
  });

  it('NOT operator inside policy works', () => {
    const policyContext = bundle({
      permissives: [
        permissive({
          operations: ['read'],
          when: () => ({ NOT: { id: 'b1' } }),
        }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain('NOT');
  });

  it('policy params merge into the result params', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'u9' }) }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(Object.values(result.params)).toContain('u9');
  });

  it('restrictive returning false short-circuits to false in the AND chain', () => {
    const policyContext = bundle({
      permissives: [permissive({ operations: ['read'], when: () => ({}) })],
      restrictives: [restrictive({ operations: ['read'], when: () => false })],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain('false');
  });

  it('user where wrapped in () when policy is appended', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
      ],
    });
    const result = compiler.compile(
      { id: 'b1' },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher.startsWith('(')).toBe(true);
  });

  it('when both override and permissive present, override wins (but compiler is told via resolved)', () => {
    // The resolver does the short-circuit; we just verify that the
    // compiler trusts `overridden: true` and emits no-policy output.
    const policyContext = bundle({
      overridden: true,
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
      ],
    });
    const result = compiler.compile(
      { id: 'b1' },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).not.toContain('ownerId');
  });

  it('passes ctx into permissive.when at compile time', () => {
    const seen: unknown[] = [];
    const policyContext = bundle(
      {
        permissives: [
          permissive({
            operations: ['read'],
            when: (c) => {
              seen.push(c);
              return { ownerId: (c as { uid: string }).uid };
            },
          }),
        ],
      },
      { uid: 'alex' },
    );
    compiler.compile(undefined, 'n', bookNode, { count: 0 }, { policyContext });
    expect(seen).toEqual([{ uid: 'alex' }]);
  });

  it('passes ctx into restrictive.when at compile time', () => {
    let captured: unknown;
    const policyContext = bundle(
      {
        permissives: [permissive({ operations: ['read'], when: () => ({}) })],
        restrictives: [
          restrictive({
            operations: ['read'],
            when: (c) => {
              captured = c;
              return { tenantId: 'x' };
            },
          }),
        ],
      },
      { tid: 'x' },
    );
    compiler.compile(undefined, 'n', bookNode, { count: 0 }, { policyContext });
    expect(captured).toEqual({ tid: 'x' });
  });

  it('multiple permissives produce wrapped fragments', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'a' }) }),
        permissive({ operations: ['read'], when: () => ({ ownerId: 'b' }) }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    // Each permissive fragment is wrapped in parens; the OR is between them.
    expect(result.cypher).toMatch(/\(.*\) OR \(.*\)/);
  });

  it('returns preludes from the policy where-partial when @cypher field is referenced', () => {
    const cypherProp = prop({
      name: 'computedScore',
      type: 'Float',
      isCypher: true,
      cypherStatement: 'RETURN 5 AS computedScore',
    });
    const localBookNode = makeNodeDef({
      typeName: 'Book',
      properties: new Map<string, PropertyDefinition>([
        ['id', prop({ name: 'id' })],
        ['computedScore', cypherProp],
      ]),
    });
    const policyContext = bundle({
      permissives: [
        permissive({
          operations: ['read'],
          when: () => ({ computedScore_GT: 3 }),
        }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      localBookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.preludes).toBeDefined();
    expect(result.preludes!.length).toBeGreaterThan(0);
  });

  it('does not modify byte-identical output when policyContext is omitted', () => {
    const a = compiler.compile({ id: 'b1' }, 'n', bookNode, { count: 0 });
    const b = compiler.compile({ id: 'b1' }, 'n', bookNode, { count: 0 });
    expect(a.cypher).toBe(b.cypher);
  });

  it('empty permissive partial means "match anything"', () => {
    const policyContext = bundle({
      permissives: [permissive({ operations: ['read'], when: () => ({}) })],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toBe('true');
  });

  it('uses op tag from bundle (no-op, sanity check)', () => {
    const policyContext: PolicyContextBundle = {
      ...bundle({
        permissives: [permissive({ operations: ['*'], when: () => ({}) })],
      }),
      operation: 'update',
    };
    expect(policyContext.operation).toBe('update');
    expect(() =>
      compiler.compile(
        undefined,
        'n',
        bookNode,
        { count: 0 },
        { policyContext },
      ),
    ).not.toThrow();
  });

  it('non-overridden bundle without any permissive → false', () => {
    const policyContext = bundle({
      permissives: [],
      restrictives: [restrictive({ operations: ['read'], when: () => ({}) })],
    });
    const result = compiler.compile(
      { id: 'b1' },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain('false');
  });

  it('AND of user where and policy preserves operator semantics', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
      ],
    });
    const result = compiler.compile(
      { id_IN: ['a', 'b'] },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain('IN');
    expect(result.cypher).toContain('AND');
  });

  it('override + restrictives still emits no policy clause', () => {
    const policyContext = bundle({
      overridden: true,
      restrictives: [restrictive({ operations: ['read'], when: () => false })],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toBe('');
  });

  it('byte-identical Cypher when bundle is omitted entirely', () => {
    const without = compiler.compile({ id: 'b1' }, 'n', bookNode, { count: 0 });
    const withEmptyOptions = compiler.compile(
      { id: 'b1' },
      'n',
      bookNode,
      { count: 0 },
      {},
    );
    expect(without.cypher).toBe(withEmptyOptions.cypher);
  });

  it('preserveVars option still works alongside policy', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'u' }) }),
      ],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { preserveVars: ['score'], policyContext },
    );
    expect(result.cypher).toContain('n.`ownerId`');
  });

  it('policy fragments receive sequential paramN tokens', () => {
    const policyContext = bundle({
      permissives: [
        permissive({ operations: ['read'], when: () => ({ ownerId: 'a' }) }),
      ],
    });
    const result = compiler.compile(
      { id: 'x' },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    // user where → param0; policy permissive → param1
    expect(result.params.param0).toBe('x');
    expect(result.params.param1).toBe('a');
  });

  it('override({ operations: ["*"] }) bundle emits no policy clause', () => {
    const policyContext = bundle({ overridden: true });
    void override; // ensure imported
    const result = compiler.compile(
      { id: 'b' },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain('n.`id`');
    expect(result.cypher).not.toContain('OR');
  });

  it('empty body returned when there is neither user where nor active policy', () => {
    const result = compiler.compile(undefined, 'n', bookNode, { count: 0 });
    expect(result.cypher).toBe('');
    expect(result.params).toEqual({});
  });
});
