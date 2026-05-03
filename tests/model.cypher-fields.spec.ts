import { Driver } from 'neo4j-driver';
import { Model } from '../src/model';
import {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../src/schema/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prop(
  name: string,
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
    isCypher: false,
    directives: [],
    ...overrides,
  };
}

function rel(
  fieldName: string,
  type: string,
  target: string,
  overrides: Partial<RelationshipDefinition> = {},
): RelationshipDefinition {
  return {
    fieldName,
    type,
    direction: 'OUT',
    target,
    isArray: true,
    isRequired: false,
    ...overrides,
  };
}

function nodeDef(
  typeName: string,
  props: PropertyDefinition[],
  rels: RelationshipDefinition[] = [],
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: new Map(rels.map((r) => [r.fieldName, r])),
    fulltextIndexes: [],
    implementsInterfaces: [],
  };
}

const statusNode = nodeDef('Status', [
  prop('id'),
  prop('name'),
  prop('statusLowerName', {
    isCypher: true,
    cypherStatement: 'RETURN toLower(this.name) AS statusLowerName',
    cypherColumnName: 'statusLowerName',
  }),
]);

const drugNode = nodeDef(
  'Drug',
  [
    prop('id', { isGenerated: true }),
    prop('drugName'),
    prop('insensitiveDrugName', {
      isCypher: true,
      cypherStatement: 'RETURN toLower(this.drugName) AS insensitiveDrugName',
      cypherColumnName: 'insensitiveDrugName',
    }),
    prop('upperDrugName', {
      isCypher: true,
      cypherStatement: 'RETURN toUpper(this.drugName) AS upperDrugName',
      cypherColumnName: 'upperDrugName',
    }),
  ],
  [rel('hasStatus', 'HAS_STATUS', 'Status', { isArray: false })],
);

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

function createMockDriver() {
  const mockSession = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: {
        counters: {
          updates: () => ({
            nodesCreated: 0,
            nodesDeleted: 0,
            relationshipsCreated: 0,
            relationshipsDeleted: 0,
          }),
        },
      },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const mockDriver = {
    session: jest.fn().mockReturnValue(mockSession),
  } as unknown as Driver;
  return { mockDriver, mockSession };
}

function getCypher(session: { run: jest.Mock }): string {
  return session.run.mock.calls[0][0] as string;
}

// ---------------------------------------------------------------------------

describe('Model — @cypher fields end-to-end', () => {
  let model: Model;
  let mockSession: ReturnType<typeof createMockDriver>['mockSession'];

  beforeEach(() => {
    Model.clearSelectionCache();
    const { mockDriver, mockSession: ms } = createMockDriver();
    mockSession = ms;
    model = new Model(drugNode, schema, mockDriver);
  });

  describe('find() — WHERE on @cypher fields', () => {
    it('emits CALL prelude between MATCH and WHERE for a @cypher filter', async () => {
      await model.find({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
      });
      const cypher = getCypher(mockSession);

      // Order: MATCH < CALL < WHERE < RETURN
      const matchIdx = cypher.indexOf('MATCH (n:`Drug`)');
      const callIdx = cypher.indexOf('CALL {');
      const whereIdx = cypher.indexOf('WHERE');
      const returnIdx = cypher.indexOf('RETURN n {');

      expect(matchIdx).toBeGreaterThan(-1);
      expect(callIdx).toBeGreaterThan(matchIdx);
      expect(whereIdx).toBeGreaterThan(callIdx);
      expect(returnIdx).toBeGreaterThan(whereIdx);

      expect(cypher).toContain(
        'WITH n, `insensitiveDrugName` AS __where_n_insensitiveDrugName',
      );
      expect(cypher).toContain(
        'WHERE __where_n_insensitiveDrugName CONTAINS $param0',
      );
    });

    it('mixes a @cypher filter with a stored-field filter', async () => {
      await model.find({
        where: {
          insensitiveDrugName_CONTAINS: 'asp',
          drugName: 'Aspirin',
        },
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        'WHERE __where_n_insensitiveDrugName CONTAINS $param0 AND n.`drugName` = $param1',
      );
    });

    it('emits prelude between fulltext CALL and WHERE', async () => {
      // The fulltext CALL binds `n` and `score`. The @cypher prelude must
      // go AFTER the fulltext call but BEFORE the WHERE, and its WITH must
      // preserve `score`.
      const drugWithFt = nodeDef('Drug', [...drugNode.properties.values()]);
      drugWithFt.fulltextIndexes = [
        { name: 'DrugSearch', fields: ['drugName'] },
      ];
      const ftSchema: SchemaMetadata = {
        ...schema,
        nodes: new Map([
          ['Drug', drugWithFt],
          ['Status', statusNode],
        ]),
      };
      const fresh = createMockDriver();
      const ftModel = new Model(drugWithFt, ftSchema, fresh.mockDriver);

      await ftModel.find({
        fulltext: { DrugSearch: { phrase: 'aspirin', score: 0.5 } },
        where: { insensitiveDrugName_CONTAINS: 'asp' },
      });
      const cypher = getCypher(fresh.mockSession);

      const ftIdx = cypher.indexOf('CALL db.index.fulltext.queryNodes');
      const callIdx = cypher.indexOf('CALL {');
      const whereIdx = cypher.indexOf('WHERE n:`Drug`');
      expect(ftIdx).toBeGreaterThan(-1);
      expect(callIdx).toBeGreaterThan(ftIdx);
      expect(whereIdx).toBeGreaterThan(callIdx);

      // The WITH that follows the user's CALL { ... } must carry `score`.
      expect(cypher).toMatch(
        /WITH n, score, `insensitiveDrugName` AS __where_n_insensitiveDrugName/,
      );
      expect(cypher).toContain(
        'score >= $ft_score AND __where_n_insensitiveDrugName CONTAINS',
      );
    });

    it('AND/OR composition dedupes a repeated @cypher field reference', async () => {
      await model.find({
        where: {
          OR: [
            { insensitiveDrugName_CONTAINS: 'asp' },
            { insensitiveDrugName_GT: 'm' },
          ],
        },
      });
      const cypher = getCypher(mockSession);

      // Only ONE CALL { ... } block at the top level.
      const callOpens = cypher.match(/CALL \{/g) ?? [];
      // (The OR generates a single dedupe entry.)
      expect(callOpens.length).toBe(1);
      expect(cypher).toContain(
        '(__where_n_insensitiveDrugName CONTAINS $param0 OR __where_n_insensitiveDrugName > $param1)',
      );
    });
  });

  describe('find() — SELECT on @cypher fields', () => {
    it('projects a @cypher field via select: { ... } API', async () => {
      await model.find({
        select: {
          id: true,
          drugName: true,
          insensitiveDrugName: true,
        },
      });
      const cypher = getCypher(mockSession);

      // Prelude must come BEFORE the RETURN.
      const callIdx = cypher.indexOf('CALL {');
      const returnIdx = cypher.indexOf('RETURN n {');
      expect(callIdx).toBeGreaterThan(-1);
      expect(returnIdx).toBeGreaterThan(callIdx);

      expect(cypher).toContain(
        'WITH n, `insensitiveDrugName` AS __sel_n_insensitiveDrugName',
      );
      expect(cypher).toContain(
        '`insensitiveDrugName`: __sel_n_insensitiveDrugName',
      );
    });

    it('projects a @cypher field via selectionSet string', async () => {
      await model.find({
        selectionSet: '{ id drugName insensitiveDrugName }',
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        'WITH n, `insensitiveDrugName` AS __sel_n_insensitiveDrugName',
      );
      expect(cypher).toContain(
        '`insensitiveDrugName`: __sel_n_insensitiveDrugName',
      );
    });

    it('projects multiple @cypher fields with unique aliases', async () => {
      await model.find({
        select: {
          id: true,
          insensitiveDrugName: true,
          upperDrugName: true,
        },
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        '`insensitiveDrugName`: __sel_n_insensitiveDrugName',
      );
      expect(cypher).toContain('`upperDrugName`: __sel_n_upperDrugName');
    });
  });

  describe('find() — combined WHERE + SELECT + sort', () => {
    it('emits all three preludes in the right order with mutually-disjoint aliases', async () => {
      await model.find({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
        select: {
          id: true,
          upperDrugName: true,
        },
        options: { sort: [{ insensitiveDrugName: 'ASC' }] },
      });
      const cypher = getCypher(mockSession);

      // The prelude order is:
      //   MATCH
      //   <where prelude>          → __where_n_insensitiveDrugName
      //   WHERE
      //   <select prelude>         → __sel_n_upperDrugName
      //   <sort prelude>           → __sort_insensitiveDrugName
      //   RETURN ... ORDER BY ...
      const matchIdx = cypher.indexOf('MATCH (n:`Drug`)');
      const wherePreludeIdx = cypher.indexOf(
        '`insensitiveDrugName` AS __where_n_insensitiveDrugName',
      );
      const whereIdx = cypher.indexOf('WHERE __where_');
      const selPreludeIdx = cypher.indexOf(
        '`upperDrugName` AS __sel_n_upperDrugName',
      );
      const sortPreludeIdx = cypher.indexOf(
        '`insensitiveDrugName` AS __sort_insensitiveDrugName',
      );
      const returnIdx = cypher.indexOf('RETURN n {');
      const orderByIdx = cypher.indexOf('ORDER BY __sort_');

      expect(matchIdx).toBeGreaterThan(-1);
      expect(wherePreludeIdx).toBeGreaterThan(matchIdx);
      expect(whereIdx).toBeGreaterThan(wherePreludeIdx);
      expect(selPreludeIdx).toBeGreaterThan(whereIdx);
      expect(sortPreludeIdx).toBeGreaterThan(selPreludeIdx);
      expect(returnIdx).toBeGreaterThan(sortPreludeIdx);
      expect(orderByIdx).toBeGreaterThan(returnIdx);

      // The sort prelude's WITH MUST carry forward `__sel_n_upperDrugName`
      // so the trailing RETURN can still reference it.
      expect(cypher).toMatch(
        /WITH n, __sel_n_upperDrugName, `insensitiveDrugName` AS __sort_insensitiveDrugName/,
      );

      // Each namespace stays distinct — alias prefixes don't collide.
      expect(cypher).toContain('__where_n_insensitiveDrugName');
      expect(cypher).toContain('__sel_n_upperDrugName');
      expect(cypher).toContain('__sort_insensitiveDrugName');
    });

    it('emits one CALL per scope when the SAME @cypher field is used in WHERE + SELECT + sort', async () => {
      // Each scope (`__where`, `__sel`, `__sort`) maintains its own dedupe
      // cache, so the same field referenced across all three scopes emits
      // three CALL blocks (one per scope). This is intentional — scopes are
      // disjoint by design so an inner-scope re-registration doesn't
      // accidentally inherit the outer-scope WITH carry chain.
      await model.find({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
        selectionSet: '{ id insensitiveDrugName }',
        options: { sort: [{ insensitiveDrugName: 'ASC' }] },
      } as Record<string, unknown>);
      const cypher = getCypher(mockSession);

      // Three CALLs, three disjoint aliases for the SAME field.
      const callOpens = cypher.match(/CALL \{/g) ?? [];
      expect(callOpens.length).toBe(3);
      expect(cypher).toContain('AS __where_n_insensitiveDrugName');
      expect(cypher).toContain('AS __sel_n_insensitiveDrugName');
      expect(cypher).toContain('AS __sort_insensitiveDrugName');

      // The sort prelude's WITH carries `__sel_n_insensitiveDrugName`
      // forward so the projected RETURN can still reference it.
      expect(cypher).toMatch(
        /WITH n, __sel_n_insensitiveDrugName, `insensitiveDrugName` AS __sort_insensitiveDrugName/,
      );
      expect(cypher).toContain(
        '`insensitiveDrugName`: __sel_n_insensitiveDrugName',
      );
      expect(cypher).toContain('ORDER BY __sort_insensitiveDrugName');
    });
  });

  describe('mutation paths — wired through every call site', () => {
    it('update() stitches WHERE preludes between MATCH and WHERE', async () => {
      await model.update({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
        update: { drugName: 'New' },
      });
      const cypher = getCypher(mockSession);
      const matchIdx = cypher.indexOf('MATCH (n:`Drug`)');
      const callIdx = cypher.indexOf('CALL {');
      const whereIdx = cypher.indexOf('WHERE __where_n_insensitiveDrugName');
      expect(matchIdx).toBeGreaterThan(-1);
      expect(callIdx).toBeGreaterThan(matchIdx);
      expect(whereIdx).toBeGreaterThan(callIdx);
    });

    it('updateMany() stitches WHERE preludes', async () => {
      await model.updateMany({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
        data: { drugName: 'New' },
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        'WITH n, `insensitiveDrugName` AS __where_n_insensitiveDrugName',
      );
      expect(cypher).toContain(
        'WHERE __where_n_insensitiveDrugName CONTAINS $param0',
      );
    });

    it('delete() stitches WHERE preludes', async () => {
      await model.delete({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain('CALL {');
      expect(cypher).toContain(
        'WITH n, `insensitiveDrugName` AS __where_n_insensitiveDrugName',
      );
      expect(cypher).toContain(
        'WHERE __where_n_insensitiveDrugName CONTAINS $param0',
      );
    });

    it('deleteMany() stitches WHERE preludes', async () => {
      await model.deleteMany({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain('CALL {');
      expect(cypher).toContain(
        'WHERE __where_n_insensitiveDrugName CONTAINS $param0',
      );
    });

    it('setLabels() stitches WHERE preludes', async () => {
      await model.setLabels({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
        addLabels: ['Active'],
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain('CALL {');
      expect(cypher).toContain(
        'WHERE __where_n_insensitiveDrugName CONTAINS $param0',
      );
    });

    it('count() stitches WHERE preludes (via aggregate)', async () => {
      await model.count({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain('CALL {');
      expect(cypher).toContain(
        'WHERE __where_n_insensitiveDrugName CONTAINS $param0',
      );
    });

    it('aggregate() stitches WHERE preludes', async () => {
      await model.aggregate({
        where: { insensitiveDrugName_CONTAINS: 'asp' },
        aggregate: { count: true },
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain('CALL {');
      expect(cypher).toContain(
        'WHERE __where_n_insensitiveDrugName CONTAINS $param0',
      );
    });

    it('update() projects @cypher fields in the RETURN via select', async () => {
      await model.update({
        where: { id: '123' },
        update: { drugName: 'New' },
        select: { drugs: { id: true, insensitiveDrugName: true } },
      });
      const cypher = getCypher(mockSession);
      // The select prelude must come before the projected RETURN.
      const callIdx = cypher.lastIndexOf('CALL {');
      const returnIdx = cypher.indexOf('RETURN n {');
      expect(callIdx).toBeGreaterThan(-1);
      expect(returnIdx).toBeGreaterThan(callIdx);
      expect(cypher).toContain(
        '`insensitiveDrugName`: __sel_n_insensitiveDrugName',
      );
    });

    it('upsert() projects @cypher fields in the RETURN', async () => {
      await model.upsert({
        where: { id: '123' },
        create: { id: '123', drugName: 'New' },
        update: { drugName: 'Updated' },
        selectionSet: '{ id insensitiveDrugName }',
      });
      const cypher = getCypher(mockSession);
      expect(cypher).toContain(
        '`insensitiveDrugName`: __sel_n_insensitiveDrugName',
      );
    });
  });

  describe('nested @cypher selection', () => {
    it('emits an inline head(COLLECT { ... }) for @cypher on a nested related node', async () => {
      // Pre-1.7.0-beta.4 this threw (`OGMError: ... only resolvable at the
      // top-level of a selection.`). We now fall back to an inline
      // head(COLLECT { WITH <var> AS this <stmt> }) projection per row of
      // the surrounding pattern comprehension.
      await model.find({
        select: {
          id: true,
          hasStatus: { select: { id: true, statusLowerName: true } },
        },
      });

      const cypher = getCypher(mockSession);
      const flat = cypher.replace(/\s+/g, ' ');
      expect(flat).toContain(
        '`statusLowerName`: head(COLLECT { WITH n0 AS this RETURN toLower(this.name) AS statusLowerName })',
      );
    });
  });

  describe('rejections', () => {
    it('rejects @cypher fields in connection where filters', async () => {
      // The hasStatusConnection path constructs a list comprehension which
      // cannot host CALL preludes.
      await expect(
        model.find({
          select: {
            hasStatusConnection: {
              where: { node: { statusLowerName_CONTAINS: 'act' } },
              select: { edges: { node: { select: { id: true } } } },
            },
          } as Record<string, unknown>,
        }),
      ).rejects.toThrow(/connection .* by an @cypher field/);
    });
  });
});
