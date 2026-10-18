/**
 * Live mutation-projection suite (issue #7, v2.3.1).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`, so it
 * is safe to point at a shared development database.
 *
 * Projecting a `@cypher` field from a mutation stitches a `CALL { ... }`
 * prelude after the write clause. Neo4j 5.x rejects a CALL that directly
 * follows SET / CREATE / MERGE ("WITH is required between SET and CALL"),
 * while 2025.x+ accepts it — so this suite only proves anything when run
 * against a 5.x server (e.g. the 5.26 LTS image).
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItPerson @node {
    id: ID! @id
    runId: String
    givenName: String
    familyName: String
    fullName: String
      @cypher(
        statement: "RETURN this.givenName + ' ' + this.familyName AS fullName"
        columnName: "fullName"
      )
    upperFamilyName: String
      @cypher(
        statement: "RETURN toUpper(this.familyName) AS upperFamilyName"
        columnName: "upperFamilyName"
      )
  }
`;

type Row = Record<string, unknown>;

/** Mutation responses are `{ itPeople: [...] }`; upsert returns the row. */
function rows(res: unknown): Row[] {
  const r = res as Row;
  for (const v of Object.values(r ?? {}))
    if (Array.isArray(v)) return v as Row[];
  return [r];
}

describeLive('Mutation @cypher projection — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;
  let ogm: OGM;
  let plural: string;

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
      { disableLosslessIntegers: true },
    );
    await driver.verifyConnectivity();
    ogm = new OGM({ typeDefs, driver });
    // Derive the response key rather than hard-coding pluralisation.
    plural = (
      ogm.model('ItPerson') as unknown as {
        nodeDef: { pluralName: string };
      }
    ).nodeDef.pluralName;
  });

  afterAll(async () => {
    if (driver) {
      const session = driver.session();
      try {
        await session.run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n', {
          runId,
        });
      } finally {
        await session.close();
      }
      await driver.close();
    }
  });

  async function seed(givenName: string, familyName: string): Promise<string> {
    const res = await ogm.model('ItPerson').create({
      input: [{ runId, givenName, familyName }],
      select: { [plural]: { id: true } },
    });
    return rows(res)[0].id as string;
  }

  it('create() with typed select projects a @cypher field', async () => {
    const res = await ogm.model('ItPerson').create({
      input: [{ runId, givenName: 'Ada', familyName: 'Lovelace' }],
      select: { [plural]: { id: true, fullName: true } },
    });
    expect(rows(res)[0].fullName).toBe('Ada Lovelace');
  });

  it('create() with several inputs projects a @cypher field on each (#12)', async () => {
    const res = await ogm.model('ItPerson').create({
      input: [
        { runId, givenName: 'Ken', familyName: 'Thompson' },
        { runId, givenName: 'Dennis', familyName: 'Ritchie' },
      ],
      select: { [plural]: { fullName: true } },
    });
    expect(rows(res).map((r) => r.fullName)).toEqual([
      'Ken Thompson',
      'Dennis Ritchie',
    ]);
  });

  it('create() with selectionSet projects a @cypher field', async () => {
    const res = await ogm.model('ItPerson').create({
      input: [{ runId, givenName: 'Grace', familyName: 'Hopper' }],
      selectionSet: `{ ${plural} { id fullName } }`,
    });
    expect(rows(res)[0].fullName).toBe('Grace Hopper');
  });

  it('update() with typed select projects the post-write value', async () => {
    const id = await seed('Alan', 'Turing');
    const res = await ogm.model('ItPerson').update({
      where: { id },
      update: { givenName: 'A.' },
      select: { [plural]: { id: true, fullName: true } },
    });
    expect(rows(res)[0].fullName).toBe('A. Turing');
  });

  it('update() with selectionSet projects several @cypher fields', async () => {
    const id = await seed('Edsger', 'Dijkstra');
    const res = await ogm.model('ItPerson').update({
      where: { id },
      update: { givenName: 'E.' },
      selectionSet: `{ ${plural} { id fullName upperFamilyName } }`,
    });
    expect(rows(res)[0]).toMatchObject({
      fullName: 'E. Dijkstra',
      upperFamilyName: 'DIJKSTRA',
    });
  });

  it('upsert() on the ON CREATE branch projects a @cypher field', async () => {
    const id = `${runId}-upsert-create`;
    const res = await ogm.model('ItPerson').upsert({
      where: { id },
      create: { id, runId, givenName: 'Barbara', familyName: 'Liskov' },
      update: { givenName: 'unused' },
      select: { id: true, fullName: true },
    });
    expect(rows(res)[0].fullName).toBe('Barbara Liskov');
  });

  it('upsert() on the ON MATCH branch projects a @cypher field', async () => {
    const id = await seed('Donald', 'Knuth');
    const res = await ogm.model('ItPerson').upsert({
      where: { id },
      create: { id, runId, givenName: 'unused', familyName: 'unused' },
      update: { givenName: 'D.' },
      selectionSet: '{ id fullName }',
    });
    expect(rows(res)[0].fullName).toBe('D. Knuth');
  });

  it('a model-level selectionSet default applies to a bare update()', async () => {
    const id = await seed('John', 'Backus');
    // A separate OGM so the model-level default can't leak into other tests
    // through the cached model instance.
    const isolated = new OGM({ typeDefs, driver });
    const model = isolated.model('ItPerson');
    model.selectionSet = '{ id fullName }';
    const res = await model.update({
      where: { id },
      update: { givenName: 'J.' },
    });
    expect(rows(res)[0].fullName).toBe('J. Backus');
  });
});
