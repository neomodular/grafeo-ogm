import {
  SelectionCompiler,
  type SelectionNode,
} from '../../src/compilers/selection.compiler';
import { WhereCompiler } from '../../src/compilers/where.compiler';
import { OGMError } from '../../src/errors';
import {
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

const tagNode: NodeDefinition = {
  typeName: 'Tag',
  label: 'Tag',
  labels: ['Tag'],
  pluralName: 'tags',
  properties: new Map([['name', prop('name')]]),
  relationships: new Map(),
  fulltextIndexes: [],
  implementsInterfaces: [],
};

const bookNode: NodeDefinition = {
  typeName: 'Book',
  label: 'Book',
  labels: ['Book'],
  pluralName: 'books',
  properties: new Map<string, PropertyDefinition>([
    ['id', prop('id')],
    ['title', prop('title')],
    ['ownerId', prop('ownerId')],
    ['tenantId', prop('tenantId')],
    [
      'computedScore',
      prop('computedScore', {
        isCypher: true,
        cypherStatement: 'RETURN 5 AS computedScore',
        type: 'Float',
      }),
    ],
  ]),
  relationships: new Map<string, RelationshipDefinition>([
    [
      'tags',
      {
        fieldName: 'tags',
        type: 'TAGGED_WITH',
        direction: 'OUT',
        target: 'Tag',
        isArray: true,
        isRequired: false,
      },
    ],
  ]),
  fulltextIndexes: [],
  implementsInterfaces: [],
};

const userNode: NodeDefinition = {
  typeName: 'User',
  label: 'User',
  labels: ['User'],
  pluralName: 'users',
  properties: new Map([['id', prop('id')]]),
  relationships: new Map<string, RelationshipDefinition>([
    [
      'ownedBooks',
      {
        fieldName: 'ownedBooks',
        type: 'OWNS',
        direction: 'OUT',
        target: 'Book',
        isArray: true,
        isRequired: false,
      },
    ],
    [
      'ownedBooksConnection',
      {
        fieldName: 'ownedBooksConnection',
        type: 'OWNS',
        direction: 'OUT',
        target: 'Book',
        isArray: true,
        isRequired: false,
      },
    ],
  ]),
  fulltextIndexes: [],
  implementsInterfaces: [],
};

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Book', bookNode],
    ['User', userNode],
    ['Tag', tagNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

function bundle(args: {
  resolveForType: (typeName: string, op: string) => ResolvedPolicies | null;
  ctx?: Record<string, unknown>;
}): PolicyContextBundle {
  return {
    ctx: args.ctx ?? {},
    operation: 'read',
    resolved: {
      overridden: false,
      permissives: [],
      restrictives: [],
      evaluated: [],
    },
    resolveForType:
      args.resolveForType as PolicyContextBundle['resolveForType'],
    defaults: { onDeny: 'empty' },
  };
}

describe('SelectionCompiler — nested-selection policy enforcement', () => {
  let where: WhereCompiler;
  let compiler: SelectionCompiler;

  beforeEach(() => {
    where = new WhereCompiler(schema);
    compiler = new SelectionCompiler(schema, where);
  });

  it('injects target type Book.read policy into a relationship pattern comprehension', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ ownerId: 'u' }),
                }),
              ],
              restrictives: [],
              evaluated: ['p1'],
            }
          : null,
    });

    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(result).toContain('WHERE');
    expect(result).toContain('n0.`ownerId`');
  });

  it('AND-combines user select.where with the policy', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        relationshipWhere: { title_CONTAINS: 'foo' },
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ ownerId: 'u' }),
                }),
              ],
              restrictives: [],
              evaluated: [],
            }
          : null,
    });

    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(result).toContain('CONTAINS');
    expect(result).toContain('ownerId');
    expect(result).toContain('AND');
  });

  it('overridden target policy emits no policy clause', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: true,
              permissives: [],
              restrictives: [],
              evaluated: ['admin'],
            }
          : null,
    });

    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(result).not.toContain('ownerId');
    expect(result).not.toContain('WHERE');
  });

  it('connection edges receive the target type policy', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooksConnection',
        isScalar: false,
        isRelationship: false,
        isConnection: true,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ ownerId: 'u' }),
                }),
              ],
              restrictives: [],
              evaluated: [],
            }
          : null,
    });

    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(result).toContain('ownerId');
  });

  it('connection where AND-combines with policy', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooksConnection',
        isScalar: false,
        isRelationship: false,
        isConnection: true,
        connectionWhere: { node: { title_CONTAINS: 'foo' } },
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ ownerId: 'u' }),
                }),
              ],
              restrictives: [],
              evaluated: [],
            }
          : null,
    });

    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(result).toContain('CONTAINS');
    expect(result).toContain('ownerId');
    expect(result).toContain('AND');
  });

  it('throws when policy references @cypher field inside nested selection', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ computedScore_GT: 3 }),
                }),
              ],
              restrictives: [],
              evaluated: [],
            }
          : null,
    });

    expect(() =>
      compiler.compile(
        selection,
        'n',
        userNode,
        5,
        0,
        params,
        paramCounter,
        null,
        policyContext,
      ),
    ).toThrow(OGMError);
  });

  it('throws with a message that mentions the type name', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ computedScore_GT: 3 }),
                }),
              ],
              restrictives: [],
              evaluated: [],
            }
          : null,
    });

    try {
      compiler.compile(
        selection,
        'n',
        userNode,
        5,
        0,
        params,
        paramCounter,
        null,
        policyContext,
      );
      throw new Error('did not throw');
    } catch (e) {
      expect((e as Error).message).toContain('Book');
      expect((e as Error).message).toContain('@cypher');
    }
  });

  it('no policy → byte-identical to no-policyContext call', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params1: Record<string, unknown> = {};
    const params2: Record<string, unknown> = {};
    const a = compiler.compile(selection, 'n', userNode, 5, 0, params1, {
      count: 0,
    });
    const b = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params2,
      { count: 0 },
      null,
      bundle({ resolveForType: () => null }),
    );
    expect(a).toBe(b);
  });

  it('multi-hop traversal injects policy at each level', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
          {
            fieldName: 'tags',
            isScalar: false,
            isRelationship: true,
            isConnection: false,
            children: [
              {
                fieldName: 'name',
                isScalar: true,
                isRelationship: false,
                isConnection: false,
              },
            ],
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) => {
        if (op !== 'read') return null;
        if (typeName === 'Book')
          return {
            overridden: false,
            permissives: [
              permissive({
                operations: ['read'],
                when: () => ({ ownerId: 'u' }),
              }),
            ],
            restrictives: [],
            evaluated: [],
          };
        if (typeName === 'Tag')
          return {
            overridden: false,
            permissives: [
              permissive({
                operations: ['read'],
                when: () => ({ name: 'foo' }),
              }),
            ],
            restrictives: [],
            evaluated: [],
          };
        return null;
      },
    });

    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(result).toContain('ownerId');
    expect(result).toContain('n1.`name`');
  });

  it('singular relationship wraps in head() and still gets policy', () => {
    const userWithSingular: NodeDefinition = {
      ...userNode,
      relationships: new Map<string, RelationshipDefinition>([
        [
          'primaryBook',
          {
            fieldName: 'primaryBook',
            type: 'PRIMARY',
            direction: 'OUT',
            target: 'Book',
            isArray: false,
            isRequired: false,
          },
        ],
      ]),
    };
    const localSchema: SchemaMetadata = {
      ...schema,
      nodes: new Map(schema.nodes).set('User', userWithSingular),
    };
    const localWhere = new WhereCompiler(localSchema);
    const localCompiler = new SelectionCompiler(localSchema, localWhere);

    const selection: SelectionNode[] = [
      {
        fieldName: 'primaryBook',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ ownerId: 'u' }),
                }),
              ],
              restrictives: [],
              evaluated: [],
            }
          : null,
    });

    const result = localCompiler.compile(
      selection,
      'n',
      userWithSingular,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(result).toContain('head([');
    expect(result).toContain('ownerId');
  });

  it('connectionWhere "edge" filter still throws (no regression)', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooksConnection',
        isScalar: false,
        isRelationship: false,
        isConnection: true,
        connectionWhere: { edge: { since: '2020' } },
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };
    expect(() =>
      compiler.compile(
        selection,
        'n',
        userNode,
        5,
        0,
        params,
        paramCounter,
        null,
        bundle({ resolveForType: () => null }),
      ),
    ).toThrow(/edge/);
  });

  it('default-deny: empty permissives → emits false in nested where', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [],
              restrictives: [
                restrictive({
                  operations: ['read'],
                  when: () => ({ tenantId: 't' }),
                }),
              ],
              evaluated: [],
            }
          : null,
    });

    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(result).toContain('false');
  });

  it('connection without user where + active policy emits WHERE policy', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooksConnection',
        isScalar: false,
        isRelationship: false,
        isConnection: true,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };

    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ ownerId: 'u' }),
                }),
              ],
              restrictives: [],
              evaluated: [],
            }
          : null,
    });

    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(result).toContain('WHERE');
    expect(result).toContain('ownerId');
  });

  it('relationship without policy resolution returns no WHERE', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      { count: 0 },
      null,
      bundle({ resolveForType: () => null }),
    );
    expect(result).not.toContain('WHERE');
  });

  it('user where without policy still works', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        relationshipWhere: { title_CONTAINS: 'foo' },
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      { count: 0 },
      null,
      bundle({ resolveForType: () => null }),
    );
    expect(result).toContain('CONTAINS');
  });

  it('preserves params across the comprehension boundary', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const paramCounter = { count: 0 };
    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ ownerId: 'OWNER42' }),
                }),
              ],
              restrictives: [],
              evaluated: [],
            }
          : null,
    });

    compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      paramCounter,
      null,
      policyContext,
    );
    expect(Object.values(params)).toContain('OWNER42');
  });

  it('non-array (head) singular relationship without policy returns head([…])', () => {
    const userWithSingular: NodeDefinition = {
      ...userNode,
      relationships: new Map<string, RelationshipDefinition>([
        [
          'primaryBook',
          {
            fieldName: 'primaryBook',
            type: 'PRIMARY',
            direction: 'OUT',
            target: 'Book',
            isArray: false,
            isRequired: false,
          },
        ],
      ]),
    };
    const localSchema: SchemaMetadata = {
      ...schema,
      nodes: new Map(schema.nodes).set('User', userWithSingular),
    };
    const localWhere = new WhereCompiler(localSchema);
    const localCompiler = new SelectionCompiler(localSchema, localWhere);

    const selection: SelectionNode[] = [
      {
        fieldName: 'primaryBook',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const result = localCompiler.compile(
      selection,
      'n',
      userWithSingular,
      5,
      0,
      {},
      { count: 0 },
    );
    expect(result.startsWith('n { primaryBook: head([')).toBe(true);
  });

  it('emits proper Cypher AST when both policies are present and relationshipWhere is empty', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        relationshipWhere: {},
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const policyContext = bundle({
      resolveForType: (typeName, op) =>
        typeName === 'Book' && op === 'read'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ ownerId: 'u' }),
                }),
              ],
              restrictives: [],
              evaluated: [],
            }
          : null,
    });
    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      { count: 0 },
      null,
      policyContext,
    );
    expect(result).toContain('WHERE');
    expect(result).toContain('ownerId');
  });

  it('connectionWhere without "node" wrapper still works', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooksConnection',
        isScalar: false,
        isRelationship: false,
        isConnection: true,
        connectionWhere: { title_CONTAINS: 'foo' },
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const policyContext = bundle({
      resolveForType: () => null,
    });
    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      { count: 0 },
      null,
      policyContext,
    );
    expect(result).toContain('CONTAINS');
  });

  it('absent target policy → comprehension WHERE matches user where only', () => {
    const selection: SelectionNode[] = [
      {
        fieldName: 'ownedBooks',
        isScalar: false,
        isRelationship: true,
        isConnection: false,
        relationshipWhere: { title_CONTAINS: 'foo' },
        children: [
          {
            fieldName: 'id',
            isScalar: true,
            isRelationship: false,
            isConnection: false,
          },
        ],
      },
    ];
    const params: Record<string, unknown> = {};
    const policyContext = bundle({ resolveForType: () => null });
    const result = compiler.compile(
      selection,
      'n',
      userNode,
      5,
      0,
      params,
      { count: 0 },
      null,
      policyContext,
    );
    expect(result).toContain('CONTAINS');
    expect(result).not.toContain('ownerId');
  });
});
