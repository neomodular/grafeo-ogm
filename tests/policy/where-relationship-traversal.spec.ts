import { OGMError } from '../../src/errors';
import { WhereCompiler } from '../../src/compilers/where.compiler';
import {
  permissive,
  restrictive,
  type Operation,
  type PolicyContextBundle,
  type ResolvedPolicies,
} from '../../src/policy/types';
import type {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../../src/schema/types';

/**
 * Regression suite for v1.8.5 / CRIT-3 — TARGET-type policy bypass via
 * `_SOME` / `_NONE` / `_ALL` / `_SINGLE` / `*Connection { node: {...} }`
 * user-where filters.
 *
 * Pre-1.8.5 the WhereCompiler recursed into the target's NodeDefinition
 * via a private `compileConditions` call WITHOUT re-resolving the
 * target's `'read'` policy. This dumped target-row data even when the
 * caller's resolved policy DENIED that row at the target level.
 *
 * These tests construct a real WhereCompiler with a real schema and a
 * real `PolicyContextBundle.resolveForType` callback (not a jest mock),
 * mirroring the pattern in `where-injection.spec.ts`.
 */

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

// ---------- Schema fixture ----------
//
// Two nodes (User, Content) wired by a single relationship `contentRel`.
// Plus a third (Comment) and an `EdgeProps` relationship-properties type
// for the connection-traversal test. Plus a union (Media = Image | Video)
// for the union-relationship test.

const userNode = makeNodeDef({
  typeName: 'User',
  properties: new Map<string, PropertyDefinition>([
    ['id', prop({ name: 'id' })],
    ['ownerId', prop({ name: 'ownerId' })],
  ]),
  relationships: new Map<string, RelationshipDefinition>([
    [
      'contentRel',
      {
        fieldName: 'contentRel',
        type: 'HAS_CONTENT',
        direction: 'OUT',
        target: 'Content',
        isArray: true,
        isRequired: false,
      },
    ],
    [
      'commentsRel',
      {
        fieldName: 'commentsRel',
        type: 'HAS_COMMENT',
        direction: 'OUT',
        target: 'Comment',
        isArray: true,
        isRequired: false,
        properties: 'EdgeProps',
      },
    ],
    [
      'mediaRel',
      {
        fieldName: 'mediaRel',
        type: 'HAS_MEDIA',
        direction: 'OUT',
        target: 'Media',
        isArray: true,
        isRequired: false,
      },
    ],
  ]),
});

const contentNode = makeNodeDef({
  typeName: 'Content',
  properties: new Map<string, PropertyDefinition>([
    ['id', prop({ name: 'id' })],
    ['tenantId', prop({ name: 'tenantId' })],
    ['title', prop({ name: 'title' })],
  ]),
});

const commentNode = makeNodeDef({
  typeName: 'Comment',
  properties: new Map<string, PropertyDefinition>([
    ['id', prop({ name: 'id' })],
    ['authorId', prop({ name: 'authorId' })],
  ]),
});

const imageNode = makeNodeDef({
  typeName: 'Image',
  properties: new Map<string, PropertyDefinition>([
    ['id', prop({ name: 'id' })],
    ['orgId', prop({ name: 'orgId' })],
  ]),
});

const videoNode = makeNodeDef({
  typeName: 'Video',
  properties: new Map<string, PropertyDefinition>([
    ['id', prop({ name: 'id' })],
  ]),
});

const schema: SchemaMetadata = {
  nodes: new Map([
    ['User', userNode],
    ['Content', contentNode],
    ['Comment', commentNode],
    ['Image', imageNode],
    ['Video', videoNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map([
    [
      'EdgeProps',
      {
        typeName: 'EdgeProps',
        properties: new Map<string, PropertyDefinition>([
          ['since', prop({ name: 'since', type: 'DateTime' })],
        ]),
      },
    ],
  ]),
  enums: new Map(),
  unions: new Map([['Media', ['Image', 'Video']]]),
};

// ---------- Helper to build a real PolicyContextBundle ----------

function buildBundle(opts: {
  ctx?: Record<string, unknown>;
  resolveByType?: Record<string, ResolvedPolicies | null>;
  defaults?: PolicyContextBundle['defaults'];
}): PolicyContextBundle {
  const ctx = opts.ctx ?? {};
  const resolveByType = opts.resolveByType ?? {};
  const defaults: PolicyContextBundle['defaults'] = opts.defaults ?? {
    onDeny: 'empty',
  };
  return {
    ctx,
    operation: 'read',
    // Top-level resolved is overridden — the source-side policy is
    // already enforced by the Model layer before this point. We only
    // need `resolveForType` reachable for crossed-boundary recursions.
    resolved: {
      overridden: true,
      permissives: [],
      restrictives: [],
      evaluated: [],
    },
    defaults,
    resolveForType: (typeName: string, op: Operation) => {
      void op;
      return resolveByType[typeName] ?? null;
    },
  };
}

// ---------- Tests ----------

describe('WhereCompiler — target-policy AND-stitch on relationship traversal (v1.8.5 CRIT-3)', () => {
  let compiler: WhereCompiler;

  beforeEach(() => {
    compiler = new WhereCompiler(schema);
  });

  it('1. _SOME + permissive on target → target predicate inside EXISTS body', () => {
    const ctx = { tenantId: 't1' };
    const policyContext = buildBundle({
      ctx,
      resolveByType: {
        Content: {
          overridden: false,
          permissives: [
            permissive({
              operations: ['read'],
              when: (c) => ({ tenantId: (c as typeof ctx).tenantId }),
            }),
          ],
          restrictives: [],
          evaluated: ['content-permissive'],
        },
      },
    });

    const result = compiler.compile(
      { contentRel_SOME: { id: 'leaked' } },
      'n',
      userNode,
      { count: 0 },
      { policyContext },
    );

    // EXISTS body must contain BOTH the user filter (id) and target
    // policy (tenantId). The two are AND-stitched inside the body. Param
    // counter starts at 0 then crosses into the relationship — both
    // user and policy share the counter, so exact param numbers are
    // not load-bearing here, but the predicate shape and presence are.
    expect(result.cypher).toMatch(/EXISTS \{ MATCH .*\}/);
    expect(result.cypher).toMatch(/r0\.`id`\s*=\s*\$param\d+/);
    expect(result.cypher).toMatch(/r0\.`tenantId`\s*=\s*\$param\d+/);
    // The policy clause is inside the EXISTS body, NOT outside as a
    // top-level n.tenantId filter on the source row.
    expect(result.cypher).not.toMatch(/n\.`tenantId`\s*=\s*\$/);
    // Param values present (we don't pin which param-N is which because
    // the recursive `compile()` advances the counter).
    expect(Object.values(result.params)).toContain('leaked');
    expect(Object.values(result.params)).toContain('t1');
  });

  it('2. _NONE + restrictive on target → restrictive AND-stitched inside NOT EXISTS', () => {
    const ctx = { tenantId: 't9' };
    const policyContext = buildBundle({
      ctx,
      resolveByType: {
        Content: {
          overridden: false,
          // Need at least one permissive for the restrictive to be
          // composed; otherwise the policy clause defaults to `false`.
          permissives: [permissive({ operations: ['read'], when: () => ({}) })],
          restrictives: [
            restrictive({
              operations: ['read'],
              when: (c) => ({ tenantId: (c as typeof ctx).tenantId }),
            }),
          ],
          evaluated: ['content-restrictive'],
        },
      },
    });

    const result = compiler.compile(
      { contentRel_NONE: { title: 'banned' } },
      'n',
      userNode,
      { count: 0 },
      { policyContext },
    );

    // The body is wrapped in NOT EXISTS { MATCH ... WHERE (user) AND
    // (perm AND restrictive) } — restrictive is inside.
    expect(result.cypher).toMatch(/^NOT EXISTS \{ MATCH .*\}/);
    expect(result.cypher).toMatch(/r0\.`title`/);
    expect(result.cypher).toMatch(/r0\.`tenantId`/);
  });

  it('3. _ALL + default-deny (target has no matching permissive) → target unreachable', () => {
    const policyContext = buildBundle({
      resolveByType: {
        Content: {
          overridden: false,
          // Default-deny: no permissives for this op.
          permissives: [],
          restrictives: [],
          evaluated: [],
        },
      },
    });

    const result = compiler.compile(
      { contentRel_ALL: { title: 'x' } },
      'n',
      userNode,
      { count: 0 },
      { policyContext },
    );

    // _ALL emits NOT EXISTS { MATCH ... WHERE NOT (inner) }. The inner
    // WHERE is `(user) AND (false)` because target permissives is empty.
    // Effectively that means "no contentRel violates the predicate" but
    // the policy reduces every target row to inaccessible.
    expect(result.cypher).toMatch(/NOT EXISTS \{ MATCH .* WHERE NOT \(/);
    expect(result.cypher).toContain('false');
  });

  it('4. *Connection { node: {...} } + permissive on target → policy inside EXISTS body', () => {
    const ctx = { tenantId: 't1' };
    const policyContext = buildBundle({
      ctx,
      resolveByType: {
        Comment: {
          overridden: false,
          permissives: [
            permissive({
              operations: ['read'],
              when: (c) => ({ authorId: (c as typeof ctx).tenantId }),
            }),
          ],
          restrictives: [],
          evaluated: ['comment-permissive'],
        },
      },
    });

    const result = compiler.compile(
      { commentsRelConnection: { node: { id: 'leaked' } } },
      'n',
      userNode,
      { count: 0 },
      { policyContext },
    );

    // EXISTS { MATCH (n)-[e0:HAS_COMMENT]->(r0:Comment) WHERE
    //   (r0.id = $paramX) AND (r0.authorId = $paramY) }
    expect(result.cypher).toMatch(/EXISTS \{ MATCH/);
    expect(result.cypher).toMatch(/r0\.`id`\s*=\s*\$param\d+/);
    expect(result.cypher).toMatch(/r0\.`authorId`\s*=\s*\$param\d+/);
    expect(Object.values(result.params)).toContain('leaked');
    expect(Object.values(result.params)).toContain('t1');
  });

  it('5. Union _SOME: { Image: {...} } + per-member permissive on Image only', () => {
    const ctx = { orgId: 'org1' };
    const policyContext = buildBundle({
      ctx,
      resolveByType: {
        Image: {
          overridden: false,
          permissives: [
            permissive({
              operations: ['read'],
              when: (c) => ({ orgId: (c as typeof ctx).orgId }),
            }),
          ],
          restrictives: [],
          evaluated: ['image-permissive'],
        },
        // Video has no policy → compiles unchanged.
      },
    });

    const result = compiler.compile(
      { mediaRel_SOME: { Image: { id: 'leaked' }, Video: { id: 'v1' } } },
      'n',
      userNode,
      { count: 0 },
      { policyContext },
    );

    // Image branch should contain the policy predicate.
    expect(result.cypher).toMatch(/r0\.`orgId`/);
    // The Video branch should NOT contain `orgId` — it has no policy.
    // The two members are joined with " OR " inside an outer pair of
    // parens. We assert directly: the full string has exactly one
    // mention of `orgId`, and Image's relVar (r0) appears in proximity
    // with `orgId` while Video's relVar (r1) does NOT.
    const orgIdCount = (result.cypher.match(/orgId/g) ?? []).length;
    expect(orgIdCount).toBe(1);
    // Image branch (r0) has both id and orgId; Video branch (r1) has
    // only id and never references orgId.
    expect(result.cypher).toMatch(/r0[\s\S]*orgId/);
    // Anchor the negative assertion: Video's relVar doesn't appear next
    // to orgId in either order.
    expect(result.cypher).not.toMatch(/r1[^|]*orgId/);
    expect(result.cypher).not.toMatch(/orgId[^|]*r1/);
  });

  it('6a. _SINGLE + permissive (stored properties only) → works', () => {
    const ctx = { tenantId: 't1' };
    const policyContext = buildBundle({
      ctx,
      resolveByType: {
        Content: {
          overridden: false,
          permissives: [
            permissive({
              operations: ['read'],
              when: (c) => ({ tenantId: (c as typeof ctx).tenantId }),
            }),
          ],
          restrictives: [],
          evaluated: ['content-permissive'],
        },
      },
    });

    const result = compiler.compile(
      { contentRel_SINGLE: { id: 'leaked' } },
      'n',
      userNode,
      { count: 0 },
      { policyContext },
    );

    // _SINGLE compiles to a `size([r0 IN [... | r0]] | r0]) = 1`
    // pattern comprehension. The WHERE inside the comprehension contains
    // both the user filter AND the policy clause.
    expect(result.cypher).toMatch(/size\(\[r0 IN \[/);
    expect(result.cypher).toMatch(/\]\) = 1$/);
    expect(result.cypher).toMatch(/r0\.`id`/);
    expect(result.cypher).toMatch(/r0\.`tenantId`/);
  });

  it('6b. _SINGLE + policy referencing @cypher field → throws specific policy-on-_SINGLE error', () => {
    // Construct a Content node whose policy references a `@cypher` field.
    const computed = prop({
      name: 'computedScore',
      type: 'Float',
      isCypher: true,
      cypherStatement: 'RETURN 5 AS computedScore',
    });
    const localContent = makeNodeDef({
      typeName: 'Content',
      properties: new Map<string, PropertyDefinition>([
        ['id', prop({ name: 'id' })],
        ['computedScore', computed],
      ]),
    });
    const localUser = makeNodeDef({
      typeName: 'User',
      relationships: new Map<string, RelationshipDefinition>([
        [
          'contentRel',
          {
            fieldName: 'contentRel',
            type: 'HAS_CONTENT',
            direction: 'OUT',
            target: 'Content',
            isArray: true,
            isRequired: false,
          },
        ],
      ]),
    });
    const localSchema: SchemaMetadata = {
      nodes: new Map([
        ['User', localUser],
        ['Content', localContent],
      ]),
      interfaces: new Map(),
      relationshipProperties: new Map(),
      enums: new Map(),
      unions: new Map(),
    };
    const localCompiler = new WhereCompiler(localSchema);

    const policyContext: PolicyContextBundle = {
      ctx: {},
      operation: 'read',
      resolved: {
        overridden: true,
        permissives: [],
        restrictives: [],
        evaluated: [],
      },
      defaults: { onDeny: 'empty' },
      resolveForType: (typeName) =>
        typeName === 'Content'
          ? {
              overridden: false,
              permissives: [
                permissive({
                  operations: ['read'],
                  when: () => ({ computedScore_GT: 3 }),
                }),
              ],
              restrictives: [],
              evaluated: ['content-cypher-policy'],
            }
          : null,
    };

    expect(() =>
      localCompiler.compile(
        { contentRel_SINGLE: { id: 'x' } },
        'n',
        localUser,
        { count: 0 },
        { policyContext },
      ),
    ).toThrow(OGMError);

    // Specific message points at the policy + target type, not the
    // generic _SINGLE-can't-use-@cypher error.
    expect(() =>
      localCompiler.compile(
        { contentRel_SINGLE: { id: 'x' } },
        'n',
        localUser,
        { count: 0 },
        { policyContext },
      ),
    ).toThrow(/Policy on "Content" requires @cypher/);
  });
});
