import { WhereCompiler } from '../src/compilers/where.compiler';
import { OGMError } from '../src/errors';
import {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../src/schema/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function storedProp(
  name: string,
  type = 'String',
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
    type,
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: false,
    directives: [],
    ...overrides,
  };
}

function cypherProp(
  name: string,
  statement: string,
  columnName?: string,
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
    type: 'String',
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: true,
    cypherStatement: statement,
    cypherColumnName: columnName,
    directives: ['cypher'],
    ...overrides,
  };
}

function makeNodeDef(
  overrides: Partial<NodeDefinition> & { typeName: string },
): NodeDefinition {
  return {
    label: overrides.typeName,
    labels: [overrides.typeName],
    pluralName: overrides.typeName.toLowerCase() + 's',
    properties: new Map(),
    relationships: new Map(),
    fulltextIndexes: [],
    implementsInterfaces: [],
    ...overrides,
  };
}

function makeRelDef(
  overrides: Partial<RelationshipDefinition> & {
    fieldName: string;
    type: string;
    target: string;
  },
): RelationshipDefinition {
  return {
    direction: 'OUT',
    isArray: true,
    isRequired: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema fixtures: Drug with `insensitiveDrugName` (@cypher) and `upperName`
// (@cypher with the same columnName); a related Status node also with
// a `@cypher` field (`statusLowerName`).
// ---------------------------------------------------------------------------

const statusNode = makeNodeDef({
  typeName: 'Status',
  properties: new Map<string, PropertyDefinition>([
    ['id', storedProp('id', 'ID')],
    ['name', storedProp('name', 'String')],
    [
      'statusLowerName',
      cypherProp(
        'statusLowerName',
        'RETURN toLower(this.name) AS statusLowerName',
        'statusLowerName',
      ),
    ],
  ]),
});

const drugNode = makeNodeDef({
  typeName: 'Drug',
  properties: new Map<string, PropertyDefinition>([
    ['id', storedProp('id', 'ID')],
    ['drugName', storedProp('drugName', 'String')],
    [
      'insensitiveDrugName',
      cypherProp(
        'insensitiveDrugName',
        'RETURN toLower(this.drugName) AS insensitiveDrugName',
        'insensitiveDrugName',
      ),
    ],
    [
      'upperName',
      // Two `@cypher` fields with the SAME columnName (`shared`) — alias
      // is keyed by GraphQL field name so they must not collide.
      cypherProp(
        'upperName',
        'RETURN toUpper(this.drugName) AS shared',
        'shared',
      ),
    ],
    [
      'lowerName',
      cypherProp(
        'lowerName',
        'RETURN toLower(this.drugName) AS shared',
        'shared',
      ),
    ],
    [
      'defaultColumn',
      // No explicit columnName — should default to the GraphQL field name.
      cypherProp('defaultColumn', 'RETURN this.drugName AS defaultColumn'),
    ],
  ]),
  relationships: new Map<string, RelationshipDefinition>([
    [
      'hasStatus',
      makeRelDef({
        fieldName: 'hasStatus',
        type: 'HAS_STATUS',
        target: 'Status',
      }),
    ],
  ]),
});

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Drug', drugNode],
    ['Status', statusNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

// ---------------------------------------------------------------------------

describe('WhereCompiler — @cypher field resolution', () => {
  let compiler: WhereCompiler;
  beforeEach(() => {
    compiler = new WhereCompiler(schema);
  });

  describe('top-level scalar conditions', () => {
    it('emits CALL prelude + WITH alias for exact-match equality (no operator suffix)', () => {
      const result = compiler.compile(
        { insensitiveDrugName: 'aspirin' },
        'n',
        drugNode,
      );
      expect(result.preludes).toBeDefined();
      expect(result.preludes!.join('\n')).toBe(
        [
          'CALL {',
          '  WITH n',
          '  WITH n AS this',
          '  RETURN toLower(this.drugName) AS insensitiveDrugName',
          '}',
          'WITH n, `insensitiveDrugName` AS __where_n_insensitiveDrugName',
        ].join('\n'),
      );
      expect(result.cypher).toBe('__where_n_insensitiveDrugName = $param0');
      expect(result.params).toEqual({ param0: 'aspirin' });
    });

    it('emits CALL prelude for _CONTAINS', () => {
      const result = compiler.compile(
        { insensitiveDrugName_CONTAINS: 'asp' },
        'n',
        drugNode,
      );
      expect(result.preludes).toBeDefined();
      expect(result.preludes!.length).toBe(2);
      expect(result.cypher).toBe(
        '__where_n_insensitiveDrugName CONTAINS $param0',
      );
      expect(result.params).toEqual({ param0: 'asp' });
    });

    it.each([
      ['_GT', '>'],
      ['_LT', '<'],
      ['_GTE', '>='],
      ['_LTE', '<='],
    ])('emits CALL prelude for %s with op %s', (suffix, operator) => {
      const result = compiler.compile(
        { [`insensitiveDrugName${suffix}`]: 'm' },
        'n',
        drugNode,
      );
      expect(result.preludes).toBeDefined();
      expect(result.cypher).toBe(
        `__where_n_insensitiveDrugName ${operator} $param0`,
      );
      expect(result.params).toEqual({ param0: 'm' });
    });

    it('emits CALL prelude for _IN', () => {
      const result = compiler.compile(
        { insensitiveDrugName_IN: ['a', 'b'] },
        'n',
        drugNode,
      );
      expect(result.preludes).toBeDefined();
      expect(result.cypher).toBe('__where_n_insensitiveDrugName IN $param0');
      expect(result.params).toEqual({ param0: ['a', 'b'] });
    });

    it('emits CALL prelude for _NOT', () => {
      const result = compiler.compile(
        { insensitiveDrugName_NOT: 'aspirin' },
        'n',
        drugNode,
      );
      expect(result.preludes).toBeDefined();
      expect(result.cypher).toBe('__where_n_insensitiveDrugName <> $param0');
      expect(result.params).toEqual({ param0: 'aspirin' });
    });

    it('emits CALL prelude for IS NULL on @cypher field', () => {
      const result = compiler.compile(
        { insensitiveDrugName: null },
        'n',
        drugNode,
      );
      expect(result.preludes).toBeDefined();
      expect(result.cypher).toBe('__where_n_insensitiveDrugName IS NULL');
    });

    it('still uses raw n.<field> for stored fields', () => {
      const result = compiler.compile({ drugName: 'aspirin' }, 'n', drugNode);
      expect(result.preludes).toBeUndefined();
      expect(result.cypher).toBe('n.`drugName` = $param0');
    });

    it('mixes a @cypher and a stored field in a single AND', () => {
      const result = compiler.compile(
        { insensitiveDrugName_CONTAINS: 'asp', drugName: 'Aspirin' },
        'n',
        drugNode,
      );
      expect(result.preludes).toBeDefined();
      expect(result.cypher).toBe(
        '__where_n_insensitiveDrugName CONTAINS $param0 AND n.`drugName` = $param1',
      );
    });

    it('defaults the columnName to the GraphQL field name when @cypher omits it', () => {
      const result = compiler.compile({ defaultColumn: 'x' }, 'n', drugNode);
      expect(result.preludes![1]).toBe(
        'WITH n, `defaultColumn` AS __where_n_defaultColumn',
      );
      expect(result.cypher).toBe('__where_n_defaultColumn = $param0');
    });

    it('produces UNIQUE aliases when two @cypher fields share a columnName', () => {
      // Both `upperName` and `lowerName` declare columnName: 'shared'. The
      // alias is keyed by GraphQL field name, so they must NOT collide.
      const result = compiler.compile(
        { upperName: 'A', lowerName: 'a' },
        'n',
        drugNode,
      );
      expect(result.preludes).toBeDefined();
      const flat = result.preludes!.join('\n');
      expect(flat).toContain('`shared` AS __where_n_upperName');
      expect(flat).toContain('`shared` AS __where_n_lowerName');
      // Each WITH carries forward the previously-projected alias so the
      // final scope contains both `n` and both `__where_*` aliases.
      expect(flat).toContain(
        'WITH n, __where_n_upperName, `shared` AS __where_n_lowerName',
      );
      expect(result.cypher).toBe(
        '__where_n_upperName = $param0 AND __where_n_lowerName = $param1',
      );
    });
  });

  describe('logical composition', () => {
    it('dedupes a @cypher field referenced twice in AND/OR (single CALL emitted)', () => {
      const result = compiler.compile(
        {
          OR: [
            { insensitiveDrugName_CONTAINS: 'asp' },
            { insensitiveDrugName_GT: 'm' },
          ],
        },
        'n',
        drugNode,
      );
      // Only ONE prelude pair (CALL + WITH) should be emitted.
      expect(result.preludes!.length).toBe(2);
      expect(result.preludes![0]).toContain('CALL {');
      expect(result.preludes![1]).toContain('AS __where_n_insensitiveDrugName');
      expect(result.cypher).toBe(
        '(__where_n_insensitiveDrugName CONTAINS $param0 OR __where_n_insensitiveDrugName > $param1)',
      );
    });

    it('dedupes inside NOT', () => {
      const result = compiler.compile(
        {
          NOT: {
            AND: [
              { insensitiveDrugName_CONTAINS: 'asp' },
              { insensitiveDrugName_NOT: 'foo' },
            ],
          },
        },
        'n',
        drugNode,
      );
      expect(result.preludes!.length).toBe(2);
      expect(result.cypher).toBe(
        'NOT ((__where_n_insensitiveDrugName CONTAINS $param0 AND __where_n_insensitiveDrugName <> $param1))',
      );
    });
  });

  describe('inside relationship quantifiers', () => {
    it('emits inner CALL prelude inside the EXISTS body for _SOME on a related @cypher field', () => {
      const result = compiler.compile(
        { hasStatus_SOME: { statusLowerName_CONTAINS: 'act' } },
        'n',
        drugNode,
      );
      // Top-level preludes should NOT be set — the prelude scope is inner.
      expect(result.preludes).toBeUndefined();
      // The inner prelude is stitched directly inside the EXISTS body,
      // between the MATCH pattern and the inner WHERE.
      expect(result.cypher).toContain(
        'EXISTS { MATCH (n)-[:`HAS_STATUS`]->(r0:`Status`) ',
      );
      expect(result.cypher).toContain('CALL {');
      expect(result.cypher).toContain('  WITH r0');
      expect(result.cypher).toContain('  WITH r0 AS this');
      expect(result.cypher).toContain(
        'WITH r0, `statusLowerName` AS __where_r0_statusLowerName',
      );
      expect(result.cypher).toContain(
        'WHERE __where_r0_statusLowerName CONTAINS $param1',
      );
    });

    it('emits inner CALL prelude inside _NONE body', () => {
      const result = compiler.compile(
        { hasStatus_NONE: { statusLowerName_CONTAINS: 'act' } },
        'n',
        drugNode,
      );
      expect(result.cypher.startsWith('NOT EXISTS {')).toBe(true);
      expect(result.cypher).toContain(
        'WITH r0, `statusLowerName` AS __where_r0_statusLowerName',
      );
    });

    it('emits inner CALL prelude inside _ALL double-negation', () => {
      const result = compiler.compile(
        { hasStatus_ALL: { statusLowerName_CONTAINS: 'act' } },
        'n',
        drugNode,
      );
      expect(result.cypher).toContain('NOT EXISTS');
      expect(result.cypher).toContain(
        'WITH r0, `statusLowerName` AS __where_r0_statusLowerName',
      );
      expect(result.cypher).toContain(
        'WHERE NOT (__where_r0_statusLowerName CONTAINS $param1)',
      );
    });

    it('rejects @cypher fields inside _SINGLE quantifiers', () => {
      expect(() =>
        compiler.compile(
          { hasStatus_SINGLE: { statusLowerName_CONTAINS: 'act' } },
          'n',
          drugNode,
        ),
      ).toThrow(OGMError);
      expect(() =>
        compiler.compile(
          { hasStatus_SINGLE: { statusLowerName_CONTAINS: 'act' } },
          'n',
          drugNode,
        ),
      ).toThrow(/_SINGLE quantifiers do not support filtering by @cypher/);
    });

    it('combines outer @cypher and inner @cypher in one query (separate scopes)', () => {
      const result = compiler.compile(
        {
          insensitiveDrugName_CONTAINS: 'asp',
          hasStatus_SOME: { statusLowerName_CONTAINS: 'act' },
        },
        'n',
        drugNode,
      );
      expect(result.preludes).toBeDefined();
      // Outer prelude is for `n`, inner is stitched inside the EXISTS for
      // a relVar (the specific number isn't load-bearing — the outer
      // scalar condition allocated a $paramN, and the relVar counter ran
      // alongside it).
      expect(result.preludes!.join('\n')).toContain(
        'WITH n, `insensitiveDrugName` AS __where_n_insensitiveDrugName',
      );
      expect(result.cypher).toContain(
        '__where_n_insensitiveDrugName CONTAINS $param0',
      );
      expect(result.cypher).toMatch(
        /EXISTS \{ MATCH \(n\)-\[:`HAS_STATUS`\]->\(r\d+:`Status`\)/,
      );
      expect(result.cypher).toMatch(
        /WITH r\d+, `statusLowerName` AS __where_r\d+_statusLowerName/,
      );
      expect(result.cypher).toMatch(
        /__where_r\d+_statusLowerName CONTAINS \$param2/,
      );
    });
  });

  describe('preserveVars option', () => {
    it('threads preserveVars into every emitted WITH', () => {
      const result = compiler.compile(
        { insensitiveDrugName_CONTAINS: 'asp', upperName: 'X' },
        'n',
        drugNode,
        undefined,
        { preserveVars: ['score'] },
      );
      const flat = result.preludes!.join('\n');
      // First WITH: WITH n, score, ... AS first_alias
      expect(flat).toContain(
        'WITH n, score, `insensitiveDrugName` AS __where_n_insensitiveDrugName',
      );
      // Second WITH: must keep `score` AND the prior alias.
      expect(flat).toContain(
        'WITH n, score, __where_n_insensitiveDrugName, `shared` AS __where_n_upperName',
      );
    });
  });
});
