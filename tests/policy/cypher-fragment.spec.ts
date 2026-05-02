import { OGMError } from '../../src/errors';
import { WhereCompiler } from '../../src/compilers/where.compiler';
import {
  permissive,
  restrictive,
  type PolicyContextBundle,
} from '../../src/policy/types';
import type {
  NodeDefinition,
  PropertyDefinition,
  SchemaMetadata,
} from '../../src/schema/types';

function prop(
  name: string,
  over: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
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

const bookNode: NodeDefinition = {
  typeName: 'Book',
  label: 'Book',
  labels: ['Book'],
  pluralName: 'books',
  properties: new Map([
    ['id', prop('id')],
    ['ownerId', prop('ownerId')],
  ]),
  relationships: new Map(),
  fulltextIndexes: [],
  implementsInterfaces: [],
};

const schema: SchemaMetadata = {
  nodes: new Map([['Book', bookNode]]),
  interfaces: new Map(),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

function policyBundle(args: {
  permissives?: PolicyContextBundle['resolved']['permissives'];
  restrictives?: PolicyContextBundle['resolved']['restrictives'];
  ctx?: Record<string, unknown>;
}): PolicyContextBundle {
  return {
    ctx: args.ctx ?? {},
    operation: 'read',
    resolved: {
      overridden: false,
      permissives: args.permissives ?? [],
      restrictives: args.restrictives ?? [],
      evaluated: [],
    },
    resolveForType: () => null,
    defaults: { onDeny: 'empty' },
  };
}

describe('WhereCompiler — policy.cypher escape hatch', () => {
  let compiler: WhereCompiler;

  beforeEach(() => {
    compiler = new WhereCompiler(schema);
  });

  it('AND-stitches a raw cypher fragment from a restrictive', () => {
    const policyContext = policyBundle({
      permissives: [permissive({ operations: ['read'], when: () => ({}) })],
      restrictives: [
        restrictive({
          operations: ['read'],
          cypher: {
            fragment: (_c, a) => `${a.node}.tier IN $tiers`,
            params: () => ({ tiers: ['A', 'B'] }),
          },
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
    expect(result.cypher).toContain('n.tier IN $policy_p0_tiers');
    expect(result.params.policy_p0_tiers).toEqual(['A', 'B']);
  });

  it('namespaces params for permissive raw cypher fragment', () => {
    const policyContext = policyBundle({
      permissives: [
        permissive({
          operations: ['read'],
          cypher: {
            fragment: (_c, a) => `${a.node}.id = $id`,
            params: () => ({ id: 'b1' }),
          },
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
    expect(result.cypher).toContain('n.id = $policy_p0_id');
    expect(result.params.policy_p0_id).toBe('b1');
  });

  it('multi-fragment params get distinct prefixes (no collision)', () => {
    const policyContext = policyBundle({
      permissives: [
        permissive({
          operations: ['read'],
          cypher: {
            fragment: (_c, a) => `${a.node}.tier = $tier`,
            params: () => ({ tier: 'A' }),
          },
        }),
        permissive({
          operations: ['read'],
          cypher: {
            fragment: (_c, a) => `${a.node}.tier = $tier`,
            params: () => ({ tier: 'B' }),
          },
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
    expect(result.params.policy_p0_tier).toBe('A');
    expect(result.params.policy_p1_tier).toBe('B');
  });

  it('does not collide with user where param namespace', () => {
    const policyContext = policyBundle({
      permissives: [
        permissive({
          operations: ['read'],
          cypher: {
            fragment: (_c, a) => `${a.node}.id = $id`,
            params: () => ({ id: 'pol' }),
          },
        }),
      ],
    });
    const result = compiler.compile(
      { id: 'usr' },
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.params.param0).toBe('usr');
    expect(result.params.policy_p0_id).toBe('pol');
  });

  it('throws when fragment is not a string', () => {
    const policyContext = policyBundle({
      permissives: [
        permissive({
          operations: ['read'],
          cypher: {
            // @ts-expect-error — runtime validation.
            fragment: () => 42,
            params: () => ({}),
          },
        }),
      ],
    });
    expect(() =>
      compiler.compile(
        undefined,
        'n',
        bookNode,
        { count: 0 },
        { policyContext },
      ),
    ).toThrow(/must return a string/);
  });

  it('rejects __proto__ as a policy params key', () => {
    const policyContext = policyBundle({
      permissives: [
        permissive({
          operations: ['read'],
          cypher: {
            fragment: () => 'true',
            params: () => ({ ['__proto__']: 'evil' }),
          },
        }),
      ],
    });
    expect(() =>
      compiler.compile(
        undefined,
        'n',
        bookNode,
        { count: 0 },
        { policyContext },
      ),
    ).toThrow(OGMError);
  });

  it('rejects unsafe identifier as a policy params key', () => {
    const policyContext = policyBundle({
      permissives: [
        permissive({
          operations: ['read'],
          cypher: {
            fragment: () => 'true',
            params: () => ({ ['bad name']: 1 }),
          },
        }),
      ],
    });
    expect(() =>
      compiler.compile(
        undefined,
        'n',
        bookNode,
        { count: 0 },
        { policyContext },
      ),
    ).toThrow(OGMError);
  });

  it('skips empty fragment strings', () => {
    const policyContext = policyBundle({
      permissives: [permissive({ operations: ['read'], when: () => ({}) })],
      restrictives: [
        restrictive({
          operations: ['read'],
          cypher: {
            fragment: () => '',
            params: () => ({}),
          },
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
    // Empty fragment contributes nothing — clause becomes just permissive
    expect(result.cypher).not.toContain('()');
  });

  it('rewrites only known fragment placeholders', () => {
    const policyContext = policyBundle({
      restrictives: [
        restrictive({
          operations: ['read'],
          cypher: {
            // Reference a builtin-like $score that we don't own — must NOT be rewritten.
            fragment: () => '$score > 0.5 AND $myParam = 1',
            params: () => ({ myParam: 1 }),
          },
        }),
      ],
      permissives: [permissive({ operations: ['read'], when: () => ({}) })],
    });
    const result = compiler.compile(
      undefined,
      'n',
      bookNode,
      { count: 0 },
      { policyContext },
    );
    expect(result.cypher).toContain('$score > 0.5');
    expect(result.cypher).toContain('$policy_p0_myParam = 1');
  });
});
