import neo4j, { Integer } from 'neo4j-driver';
import { MutationCompiler } from '../src/compilers/mutation.compiler';
import { WhereCompiler } from '../src/compilers/where.compiler';
import { OGMError } from '../src/errors';
import {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../src/schema/types';

// ─── Helper factories ────────────────────────────────────────────

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
    isArray: false,
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

// ─── Mock schema ─────────────────────────────────────────────────

const sessionNode = nodeDef('Session', [
  prop('id', { isGenerated: true }),
  prop('name'),
  prop('when', { type: 'DateTime' }),
]);

const eventNode = nodeDef(
  'Event',
  [
    prop('id', { isGenerated: true }),
    prop('slug', { isUnique: true }),
    prop('title'),
    prop('startsAt', { type: 'DateTime' }),
    prop('day', { type: 'Date' }),
    prop('localAt', { type: 'LocalDateTime' }),
    prop('runtime', { type: 'Duration' }),
    prop('slots', { type: 'DateTime', isArray: true }),
    prop('plays', { type: 'BigInt' }),
    prop('position', { type: 'Int' }),
    prop('location', { type: 'Point' }),
    prop('origin', { type: 'CartesianPoint' }),
    prop('route', { type: 'Point', isArray: true }),
  ],
  [
    rel('sessions', 'HAS_SESSION', 'Session', {
      isArray: true,
      properties: 'SessionEdgeProps',
    }),
  ],
);

const defaultedNode = nodeDef('Task', [
  prop('id', { isGenerated: true }),
  prop('slug', { isUnique: true }),
  prop('title'),
  prop('status', { defaultValue: 'DRAFT' }),
  prop('priority', { type: 'Int', defaultValue: '5' }),
  prop('isActive', { type: 'Boolean', defaultValue: 'true' }),
  prop('score', { type: 'Float', defaultValue: '1.5' }),
  prop('openedAt', { type: 'DateTime', defaultValue: '2024-01-01T00:00:00Z' }),
]);

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Event', eventNode],
    ['Session', sessionNode],
    ['Task', defaultedNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map([
    [
      'SessionEdgeProps',
      {
        typeName: 'SessionEdgeProps',
        properties: new Map([
          ['at', prop('at', { type: 'DateTime' })],
          ['order', prop('order', { type: 'Int' })],
        ]),
      },
    ],
  ]),
  enums: new Map(),
  unions: new Map(),
};

const emptyWhere = { cypher: '', params: {} };
const ISO = '2024-01-15T10:30:00Z';

// ─── Tests ───────────────────────────────────────────────────────

describe('type-faithful writes (temporal, BigInt strings, @default)', () => {
  let compiler: MutationCompiler;
  let whereCompiler: WhereCompiler;

  beforeEach(() => {
    compiler = new MutationCompiler(schema);
    whereCompiler = new WhereCompiler(schema);
  });

  describe('temporal writes', () => {
    it('wraps ISO-string DateTime creates in datetime()', () => {
      const result = compiler.compileCreate(
        [{ title: 'Launch', startsAt: ISO }],
        eventNode,
      );
      expect(result.cypher).toContain(
        '`startsAt`: datetime($create0_startsAt)',
      );
      expect(result.params.create0_startsAt).toBe(ISO);
    });

    it('uses the constructor matching each temporal type', () => {
      const result = compiler.compileCreate(
        [
          {
            day: '2024-01-15',
            localAt: '2024-01-15T10:30:00',
            runtime: 'P1DT2H',
          },
        ],
        eventNode,
      );
      expect(result.cypher).toContain('`day`: date($create0_day)');
      expect(result.cypher).toContain(
        '`localAt`: localdatetime($create0_localAt)',
      );
      expect(result.cypher).toContain('`runtime`: duration($create0_runtime)');
    });

    it('does NOT wrap driver temporal objects', () => {
      const dt = new neo4j.types.DateTime(2024, 1, 15, 10, 30, 0, 0, 0);
      const result = compiler.compileCreate([{ startsAt: dt }], eventNode);
      expect(result.cypher).toContain('`startsAt`: $create0_startsAt');
      expect(result.cypher).not.toContain('datetime(');
      expect(result.params.create0_startsAt).toBe(dt);
    });

    it('wraps temporal list fields element-wise', () => {
      const result = compiler.compileCreate(
        [{ slots: [ISO, '2024-01-16T10:30:00Z'] }],
        eventNode,
      );
      expect(result.cypher).toContain(
        '`slots`: [wc_t IN $create0_slots | datetime(wc_t)]',
      );
    });

    it('wraps update SET and leaves null unwrapped', () => {
      const result = compiler.compileUpdate(
        {},
        { startsAt: ISO },
        undefined,
        undefined,
        eventNode,
        emptyWhere,
      );
      expect(result.cypher).toContain(
        'n.`startsAt` = datetime($update_startsAt)',
      );

      const cleared = compiler.compileUpdate(
        {},
        { startsAt: null },
        undefined,
        undefined,
        eventNode,
        emptyWhere,
      );
      expect(cleared.cypher).toContain('n.`startsAt` = $update_startsAt');
      expect(cleared.params.update_startsAt).toBeNull();
    });

    it('wraps upsert ON CREATE and ON MATCH branches', () => {
      const result = compiler.compileMerge(
        { slug: 'launch' },
        { startsAt: ISO },
        { startsAt: ISO },
        eventNode,
      );
      expect(result.cypher).toContain(
        'n.`startsAt` = datetime($onCreate_startsAt)',
      );
      expect(result.cypher).toContain(
        'n.`startsAt` = datetime($onMatch_startsAt)',
      );
    });

    it('wraps createMany item references for all-string columns', () => {
      const result = compiler.compileCreateMany(
        [{ startsAt: ISO }, { startsAt: '2024-02-01T00:00:00Z' }],
        eventNode,
      );
      expect(result.cypher).toContain('`startsAt`: datetime(item.`startsAt`)');
    });

    it('rejects mixed string/object temporal columns in createMany', () => {
      const dt = new neo4j.types.DateTime(2024, 1, 15, 10, 30, 0, 0, 0);
      expect(() =>
        compiler.compileCreateMany(
          [{ startsAt: ISO }, { startsAt: dt }],
          eventNode,
        ),
      ).toThrow(OGMError);
    });

    it('wraps temporal edge properties on connect and nested update', () => {
      const connect = compiler.compileUpdate(
        {},
        undefined,
        { sessions: { where: { node: { name: 's' } }, edge: { at: ISO } } },
        undefined,
        eventNode,
        emptyWhere,
      );
      expect(connect.cypher).toContain(
        'r.`at` = datetime($connect_sessions_edge_at)',
      );

      const nested = compiler.compileUpdate(
        {},
        {
          sessions: {
            where: { node: { name: 's' } },
            update: { node: { when: ISO }, edge: { at: ISO } },
          },
        },
        undefined,
        undefined,
        eventNode,
        emptyWhere,
      );
      expect(nested.cypher).toContain(
        '.`when` = datetime($update_sessions_0_set_when)',
      );
      expect(nested.cypher).toContain(
        '.`at` = datetime($update_sessions_0_edge_at)',
      );
    });

    it('wraps temporal edge properties in the UNWIND array-connect path', () => {
      const result = compiler.compileUpdate(
        {},
        undefined,
        {
          sessions: [
            { where: { node: { name: 'a' } }, edge: { at: ISO } },
            { where: { node: { name: 'b' } }, edge: { at: ISO } },
          ],
        },
        undefined,
        eventNode,
        emptyWhere,
      );
      expect(result.cypher).toContain('r.`at` = datetime(connItem.edge.at)');
    });
  });

  describe('temporal WHERE comparisons', () => {
    it('wraps equality and range params for temporal fields', () => {
      const eq = whereCompiler.compile({ startsAt: ISO }, 'n', eventNode);
      expect(eq.cypher).toContain('n.`startsAt` = datetime($param0)');

      const gt = whereCompiler.compile({ startsAt_GT: ISO }, 'n', eventNode);
      expect(gt.cypher).toContain('n.`startsAt` > datetime($param0)');
    });

    it('wraps _IN list params element-wise', () => {
      const result = whereCompiler.compile(
        { startsAt_IN: [ISO, '2024-02-01T00:00:00Z'] },
        'n',
        eventNode,
      );
      expect(result.cypher).toContain(
        'n.`startsAt` IN [wc_t IN $param0 | datetime(wc_t)]',
      );
    });

    it('leaves string operators and non-temporal fields unwrapped', () => {
      const contains = whereCompiler.compile(
        { title_CONTAINS: 'x' },
        'n',
        eventNode,
      );
      expect(contains.cypher).not.toContain('datetime(');

      const plain = whereCompiler.compile({ title: 'x' }, 'n', eventNode);
      expect(plain.cypher).toContain('n.`title` = $param0');
    });

    it('does not wrap driver temporal object params', () => {
      const dt = new neo4j.types.DateTime(2024, 1, 15, 10, 30, 0, 0, 0);
      const result = whereCompiler.compile({ startsAt: dt }, 'n', eventNode);
      expect(result.cypher).toContain('n.`startsAt` = $param0');
    });

    it('wraps temporal conditions in connect WHERE paths', () => {
      const single = compiler.compileUpdate(
        {},
        undefined,
        { sessions: { where: { node: { when_GT: ISO } } } },
        undefined,
        eventNode,
        emptyWhere,
      );
      expect(single.cypher).toContain(
        '.`when` > datetime($connect_sessions_when_GT)',
      );
    });
  });

  describe('BigInt / Int string inputs', () => {
    it('coerces integer strings for BigInt fields (the generated contract)', () => {
      const result = compiler.compileCreate(
        [{ plays: '9007199254740995' }],
        eventNode,
      );
      expect(neo4j.isInt(result.params.create0_plays)).toBe(true);
      expect((result.params.create0_plays as Integer).toString()).toBe(
        '9007199254740995',
      );
    });

    it('coerces integer strings for Int fields', () => {
      const result = compiler.compileCreate([{ position: '7' }], eventNode);
      expect(neo4j.isInt(result.params.create0_position)).toBe(true);
      expect((result.params.create0_position as Integer).toNumber()).toBe(7);
    });

    it('rejects non-integer strings for integer fields', () => {
      expect(() =>
        compiler.compileCreate([{ plays: 'not-a-number' }], eventNode),
      ).toThrow(OGMError);
      expect(() =>
        compiler.compileCreate([{ position: '5.5' }], eventNode),
      ).toThrow(OGMError);
    });
  });

  describe('@default on create', () => {
    it('applies defaults for absent fields, converted by scalar type', () => {
      const result = compiler.compileCreate([{ title: 'Ship' }], defaultedNode);
      expect(result.params.create0_status).toBe('DRAFT');
      expect(neo4j.isInt(result.params.create0_priority)).toBe(true);
      expect((result.params.create0_priority as Integer).toNumber()).toBe(5);
      expect(result.params.create0_isActive).toBe(true);
      expect(result.params.create0_score).toBe(1.5);
      // Temporal defaults get the same constructor wrapper as user input
      expect(result.cypher).toContain(
        '`openedAt`: datetime($create0_openedAt)',
      );
      expect(result.params.create0_openedAt).toBe('2024-01-01T00:00:00Z');
    });

    it('lets provided values and explicit null win over defaults', () => {
      const provided = compiler.compileCreate(
        [{ status: 'LIVE' }],
        defaultedNode,
      );
      expect(provided.params.create0_status).toBe('LIVE');

      const nulled = compiler.compileCreate([{ status: null }], defaultedNode);
      expect(nulled.params.create0_status).toBeNull();
    });

    it('does not apply defaults on update', () => {
      const result = compiler.compileUpdate(
        {},
        { title: 'Renamed' },
        undefined,
        undefined,
        defaultedNode,
        emptyWhere,
      );
      expect(result.params).not.toHaveProperty('update_status');
      expect(result.cypher).not.toContain('status');
    });

    it('applies defaults in the upsert ON CREATE branch only', () => {
      const result = compiler.compileMerge(
        { slug: 'ship' },
        { title: 'Ship' },
        { title: 'Renamed' },
        defaultedNode,
      );
      expect(result.cypher).toContain('n.`status` = $onCreate_status');
      expect(result.params.onCreate_status).toBe('DRAFT');
      expect(result.params).not.toHaveProperty('onMatch_status');
    });

    it('applies whole-column defaults in createMany (CREATE and MERGE paths)', () => {
      const created = compiler.compileCreateMany(
        [{ title: 'a' }, { title: 'b' }],
        defaultedNode,
      );
      expect(created.cypher).toContain('`status`: $default_status');
      expect(created.params.default_status).toBe('DRAFT');
      expect(neo4j.isInt(created.params.default_priority)).toBe(true);

      const merged = compiler.compileCreateMany(
        [{ slug: 's1', title: 'a' }],
        defaultedNode,
        true,
      );
      expect(merged.cypher).toContain('n.`status` = $default_status');
      expect(merged.params.default_status).toBe('DRAFT');
    });

    it('does not apply a default when the column is provided by any item', () => {
      const result = compiler.compileCreateMany(
        [{ title: 'a', status: 'LIVE' }, { title: 'b' }],
        defaultedNode,
      );
      expect(result.params).not.toHaveProperty('default_status');
    });
  });

  describe('Point round-trip writes', () => {
    const flatPoint = { x: 1.5, y: 2.5, srid: 7203 };

    it('wraps plain point objects in point() on create and update', () => {
      const created = compiler.compileCreate(
        [{ location: flatPoint }],
        eventNode,
      );
      expect(created.cypher).toContain('`location`: point($create0_location)');
      expect(created.params.create0_location).toBe(flatPoint);

      const updated = compiler.compileUpdate(
        {},
        { location: flatPoint },
        undefined,
        undefined,
        eventNode,
        emptyWhere,
      );
      expect(updated.cypher).toContain(
        'n.`location` = point($update_location)',
      );
    });

    it('wraps geographic input and CartesianPoint fields', () => {
      const result = compiler.compileCreate(
        [
          {
            location: { longitude: -103.4, latitude: 20.6 },
            origin: { x: 0, y: 0 },
          },
        ],
        eventNode,
      );
      expect(result.cypher).toContain('`location`: point($create0_location)');
      expect(result.cypher).toContain('`origin`: point($create0_origin)');
    });

    it('binds driver Point instances raw', () => {
      const native = new neo4j.types.Point(4326, 1, 2);
      const result = compiler.compileCreate([{ location: native }], eventNode);
      expect(result.cypher).toContain('`location`: $create0_location');
      expect(result.cypher).not.toContain('point(');
      expect(result.params.create0_location).toBe(native);
    });

    it('wraps Point list fields element-wise and rejects mixed lists', () => {
      const wrapped = compiler.compileCreate(
        [{ route: [flatPoint, { x: 3, y: 4 }] }],
        eventNode,
      );
      expect(wrapped.cypher).toContain(
        '`route`: [wc_t IN $create0_route | point(wc_t)]',
      );

      const native = new neo4j.types.Point(4326, 1, 2);
      expect(() =>
        compiler.compileCreate([{ route: [flatPoint, native] }], eventNode),
      ).toThrow(OGMError);
    });

    it('wraps WHERE equality and _IN params for Point fields', () => {
      const eq = whereCompiler.compile({ location: flatPoint }, 'n', eventNode);
      expect(eq.cypher).toContain('n.`location` = point($param0)');

      const inList = whereCompiler.compile(
        { location_IN: [flatPoint, { x: 9, y: 9 }] },
        'n',
        eventNode,
      );
      expect(inList.cypher).toContain(
        'n.`location` IN [wc_t IN $param0 | point(wc_t)]',
      );
    });

    it('wraps createMany point columns and rejects mixed columns', () => {
      const result = compiler.compileCreateMany(
        [{ location: flatPoint }, { location: { x: 3, y: 4 } }],
        eventNode,
      );
      expect(result.cypher).toContain('`location`: point(item.`location`)');

      const native = new neo4j.types.Point(4326, 1, 2);
      expect(() =>
        compiler.compileCreateMany(
          [{ location: flatPoint }, { location: native }],
          eventNode,
        ),
      ).toThrow(OGMError);
    });

    it('leaves non-point-shaped objects on Point fields unwrapped', () => {
      const result = compiler.compileCreate(
        [{ location: { foo: 1 } }],
        eventNode,
      );
      expect(result.cypher).toContain('`location`: $create0_location');
    });
  });
});
