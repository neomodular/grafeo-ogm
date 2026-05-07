/**
 * v1.8.4 REGRESSION TESTS — `__typename` always auto-emitted on Model
 *
 * Pre-1.8.4, `Model.find/findFirst/findUnique/searchByVector/searchByPhrase`
 * with no `select`/`selectionSet` returned the schema's scalar fields
 * but NOT `__typename`. Mutations without explicit selection returned
 * the raw Neo4j Node (also no `__typename`). Apollo Client cache
 * normalisation, type-discriminated unions in TS callers, and any
 * consumer using `__typename` as a discriminator silently saw
 * `undefined`.
 *
 * `@neo4j/graphql-ogm` (the deprecated upstream this project continues)
 * always emitted `__typename`. v1.8.4 closes that backwards-compat gap.
 *
 * The fix lives in `Model.defaultSelection()` (which now includes
 * `__typename` as the first scalar) and in the three mutation
 * projection helpers (`applySelectionSetToMutation`,
 * `applySelectionSetToUpsert`) that previously bailed to a bare
 * `RETURN n` when no selection was provided.
 *
 * Pre-1.8.4 explicit-selection paths are unchanged — callers who
 * provide `select`/`selectionSet` get exactly what they ask for.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';

const schema = `
type Book @node {
  id: ID! @id @unique
  title: String!
  pageCount: Int
}

interface Vehicle {
  id: ID!
  make: String!
}

type Car implements Vehicle @node(labels: ["Vehicle", "Car"]) {
  id: ID! @id @unique
  make: String!
  doors: Int
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function createMockDriver(records: Recorded[] = []): Driver {
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      records.push({ cypher, params });
      return Promise.resolve({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
              propertiesSet: 0,
            }),
          },
        },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
}

describe('v1.8.4 — Model auto-emits __typename for parity with @neo4j/graphql-ogm', () => {
  describe('Model.find()', () => {
    it('default selection includes __typename: <typeName>', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.model('Book').find({});

      expect(recorded[0].cypher).toContain("__typename: 'Book'");
      // Existing schema scalars must remain in the projection.
      expect(recorded[0].cypher).toContain('.`id`');
      expect(recorded[0].cypher).toContain('.`title`');
      expect(recorded[0].cypher).toContain('.`pageCount`');
    });

    it('explicit `select` is respected — does NOT auto-inject __typename when not asked', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.model('Book').find({ select: { id: true, title: true } });

      // The user opted into a specific projection. We trust them.
      expect(recorded[0].cypher).toContain('.`id`');
      expect(recorded[0].cypher).toContain('.`title`');
      expect(recorded[0].cypher).not.toContain('__typename');
      expect(recorded[0].cypher).not.toContain('.`pageCount`');
    });

    it('explicit `select: { __typename: true }` emits the type constant', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.model('Book').find({ select: { __typename: true } });

      expect(recorded[0].cypher).toContain("__typename: 'Book'");
    });

    it('explicit selectionSet without __typename does NOT auto-inject it', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.model('Book').find({ selectionSet: '{ id title }' });

      expect(recorded[0].cypher).toContain('.`id`');
      expect(recorded[0].cypher).toContain('.`title`');
      expect(recorded[0].cypher).not.toContain('__typename');
    });
  });

  describe('Model.findFirst() / findUnique() / searchByPhrase()', () => {
    it('findFirst() default selection includes __typename', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.model('Book').findFirst({});

      expect(recorded[0].cypher).toContain("__typename: 'Book'");
    });

    it('findUnique() default selection includes __typename', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.model('Book').findUnique({ where: { id: 'b1' } });

      expect(recorded[0].cypher).toContain("__typename: 'Book'");
    });
  });

  describe('Model mutations — auto-emit on default-projection paths', () => {
    it('create() with no select projects __typename', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.model('Book').create({ input: [{ title: 'Dune' }] });

      // Pre-1.8.4 emitted bare `RETURN n` — Node properties had no __typename.
      // Post-1.8.4 the default projection is applied.
      expect(recorded[0].cypher).toContain("__typename: 'Book'");
      expect(recorded[0].cypher).not.toMatch(/RETURN n\s*$/);
    });

    it('update() with no select projects __typename', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm
        .model('Book')
        .update({ where: { id: 'b1' }, update: { title: 'X' } });

      expect(recorded[0].cypher).toContain("__typename: 'Book'");
    });

    it('upsert() with no select projects __typename', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.model('Book').upsert({
        where: { id: 'b1' },
        create: { id: 'b1', title: 'X' },
        update: { title: 'X' },
      });

      expect(recorded[0].cypher).toContain("__typename: 'Book'");
    });

    it('explicit selectionSet on mutation is still respected', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.model('Book').create({
        input: [{ title: 'Dune' }],
        selectionSet: '{ books { id title } }',
      });

      // User asked for id+title only — we MUST NOT silently inject __typename.
      expect(recorded[0].cypher).toContain('.`id`');
      expect(recorded[0].cypher).toContain('.`title`');
      expect(recorded[0].cypher).not.toContain('__typename');
    });
  });

  describe('Interface targets remain unchanged', () => {
    it('InterfaceModel still auto-emits __typename via CASE-per-label', async () => {
      const recorded: Recorded[] = [];
      const ogm = new OGM({
        typeDefs: schema,
        driver: createMockDriver(recorded),
      });

      await ogm.interfaceModel('Vehicle').find({});

      // InterfaceModel synthesises __typename from labels(n) — different
      // mechanism than Model's constant string. This path is unchanged.
      expect(recorded[0].cypher).toContain('END AS __typename');
      expect(recorded[0].cypher).toContain('__typename: __typename');
    });
  });
});
