/**
 * Live suite for strict item 23 (v2.11.0): `@node(labels: [...])` as in
 * @neo4j/graphql, where the listed labels REPLACE the type name.
 *
 * Data block: opt-in on NEO4J_URI. Nodes are written the way upstream
 * writes them (`:ItLbHuman`, `:ItLbK9:ItLbPet`, no type-name label) and
 * tagged with a per-run `runId`; `afterAll` deletes them. Under strict
 * they are found, updated, connected and deleted, `__typename` resolves
 * to the GraphQL type, and creates carry exactly the listed labels. In
 * default mode (2.x) the same nodes are invisible.
 *
 * Schema block: opt-in on NEO4J_SCHEMA_URI (+ NEO4J_SCHEMA_PASSWORD), a
 * separate gate because it creates and drops constraints: point it only
 * at a throwaway server. It checks that `db push --strict` and
 * `assertIndexesAndConstraints` put the constraint on labels[0], and
 * drops every `ItLb*` constraint it made.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import neo4j, { Driver } from 'neo4j-driver';
import { runDbPush } from '../../src/cli/commands/db-push';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

jest.setTimeout(120_000);

const URI = process.env.NEO4J_URI;
const USER = process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j';
const PASSWORD = process.env.NEO4J_PASSWORD ?? 'password';
const SCHEMA_URI = process.env.NEO4J_SCHEMA_URI;
const SCHEMA_PASSWORD =
  process.env.NEO4J_SCHEMA_PASSWORD ?? process.env.NEO4J_PASSWORD ?? 'password';

const describeLive = URI ? describe : describe.skip;
const describeSchema = SCHEMA_URI ? describe : describe.skip;

const typeDefs = /* GraphQL */ `
  interface ItLbAnimal {
    id: ID!
    runId: String
    name: String
  }
  type ItLbPerson @node(labels: ["ItLbHuman"]) {
    id: ID! @id @unique
    runId: String
    name: String
    pets: [ItLbAnimal!]! @relationship(type: "ITLB_OWNS", direction: OUT)
    favorite: ItLbDog @relationship(type: "ITLB_FAV", direction: OUT)
  }
  type ItLbDog implements ItLbAnimal @node(labels: ["ItLbK9", "ItLbPet"]) {
    id: ID! @id @unique
    runId: String
    name: String
    tenantId: String
  }
  type ItLbCat implements ItLbAnimal @node(labels: ["ItLbCat", "ItLbPet"]) {
    id: ID! @id @unique
    runId: String
    name: String
  }
`;

async function cypher(
  driver: Driver,
  query: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  const session = driver.session();
  try {
    const res = await session.run(query, params);
    return res.records.map((r) => r.toObject());
  } finally {
    await session.close();
  }
}

describeLive('strict item 23 — @node(labels) data, live Neo4j', () => {
  let driver: Driver;
  let strict: OGM;
  let lenient: OGM;
  const runId = `lb${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const id = (s: string) => `${runId}-${s}`;
  const labelsOf = async (nodeId: string) =>
    (
      (
        await cypher(driver, 'MATCH (n {id: $id}) RETURN labels(n) AS l', {
          id: nodeId,
        })
      )[0]?.l as string[] | undefined
    )?.sort();

  beforeAll(async () => {
    driver = neo4j.driver(URI!, neo4j.auth.basic(USER, PASSWORD));
    strict = new OGM({
      typeDefs,
      driver,
      strict: true,
      policies: {
        ItLbDog: [
          permissive({
            operations: ['read', 'update'],
            when: (ctx) => ({ tenantId: ctx.tenantId as string }),
          }),
        ],
      },
    });
    lenient = new OGM({ typeDefs, driver });
    // Written as @neo4j/graphql writes them: no type-name label.
    await cypher(
      driver,
      `CREATE (p:ItLbHuman {id: $p, runId: $run, name: 'Ann'})
       CREATE (d:ItLbK9:ItLbPet {id: $d, runId: $run, name: 'Rex', tenantId: 't1'})
       CREATE (c:ItLbCat:ItLbPet {id: $c, runId: $run, name: 'Tom'})
       CREATE (p)-[:ITLB_OWNS]->(d)
       CREATE (p)-[:ITLB_OWNS]->(c)`,
      { p: id('p'), d: id('d'), c: id('c'), run: runId },
    );
  });

  afterAll(async () => {
    await cypher(driver, 'MATCH (n {runId: $run}) DETACH DELETE n', {
      run: runId,
    });
    await driver.close();
  });

  const mine = { runId } as never;

  it('default mode (2.x) does not see upstream-written nodes', async () => {
    expect(await lenient.model('ItLbPerson').find({ where: mine })).toEqual([]);
    expect(await lenient.model('ItLbDog').count({ where: mine })).toBe(0);
  });

  it('strict finds them, with relationships, interface members and __typename', async () => {
    const people = (await strict.model('ItLbPerson').find({
      where: mine,
      selectionSet: `{ id name pets { __typename id name } }`,
    })) as Array<{ id: string; pets: Array<Record<string, unknown>> }>;
    expect(people.map((p) => p.id)).toEqual([id('p')]);
    expect(
      people[0].pets
        .map((p) => [p.__typename, p.id])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([
      ['ItLbCat', id('c')],
      ['ItLbDog', id('d')],
    ]);
    const animals = (await strict.interfaceModel('ItLbAnimal').find({
      where: mine,
      selectionSet: '{ id }',
      options: { sort: [{ id: 'ASC' }] },
    })) as Array<Record<string, unknown>>;
    expect(animals.map((a) => [a.__typename, a.id])).toEqual([
      ['ItLbCat', id('c')],
      ['ItLbDog', id('d')],
    ]);
    expect(
      await strict.model('ItLbPerson').count({
        where: { runId, pets_SOME: { name: 'Rex' } } as never,
      }),
    ).toBe(1);
  });

  it('strict update, connect and policies reach them', async () => {
    await strict.model('ItLbDog').update({
      where: { id: id('d') } as never,
      update: { name: 'Max' } as never,
    });
    await strict.model('ItLbPerson').update({
      where: { id: id('p') } as never,
      connect: { favorite: { where: { node: { id: id('d') } } } } as never,
    });
    const [p] = (await strict.model('ItLbPerson').find({
      where: { id: id('p') } as never,
      selectionSet: '{ favorite { id name } }',
    })) as Array<{ favorite: { id: string; name: string } }>;
    expect(p.favorite).toEqual({ id: id('d'), name: 'Max' });
    // The ItLbDog read policy, keyed by the member's labels.
    const seen = (tenantId: string) =>
      strict.withContext({ tenantId }).model('ItLbDog').count({ where: mine });
    expect(await seen('t1')).toBe(1);
    expect(await seen('other')).toBe(0);
  });

  it('strict creates carry exactly the listed labels (nested ones too)', async () => {
    await strict.model('ItLbPerson').create({
      input: [
        {
          id: id('p2'),
          runId,
          pets: { create: [{ node: { ItLbDog: { id: id('d2'), runId } } }] },
        },
      ] as never,
    });
    await strict.model('ItLbCat').createMany({
      data: [{ id: id('c2'), runId }] as never,
    });
    await strict.model('ItLbDog').upsert({
      where: { id: id('d3') } as never,
      create: { runId } as never,
      update: {} as never,
    });
    expect(await labelsOf(id('p2'))).toEqual(['ItLbHuman']);
    expect(await labelsOf(id('d2'))).toEqual(['ItLbK9', 'ItLbPet']);
    expect(await labelsOf(id('c2'))).toEqual(['ItLbCat', 'ItLbPet']);
    expect(await labelsOf(id('d3'))).toEqual(['ItLbK9', 'ItLbPet']);
    // Default mode still adds the type name, as in 2.x.
    await lenient.model('ItLbPerson').create({
      input: [{ id: id('p3'), runId }] as never,
    });
    expect(await labelsOf(id('p3'))).toEqual(['ItLbHuman', 'ItLbPerson']);
    // ...and strict still finds those grafeo-written nodes (they carry the
    // listed labels too).
    expect(
      await strict
        .model('ItLbPerson')
        .count({ where: { id: id('p3') } as never }),
    ).toBe(1);
  });

  it('strict disconnect and delete reach them', async () => {
    await strict.model('ItLbPerson').update({
      where: { id: id('p') } as never,
      disconnect: { pets: [{ where: { node: { id: id('c') } } }] } as never,
    });
    expect(
      await cypher(
        driver,
        'MATCH (:ItLbHuman {id: $p})-[r:ITLB_OWNS]->() RETURN count(r) AS n',
        { p: id('p') },
      ),
    ).toEqual([{ n: neo4j.int(1) }]);
    await strict.model('ItLbCat').delete({ where: { id: id('c') } as never });
    expect(await labelsOf(id('c'))).toBeUndefined();
  });
});

describeSchema('strict item 23 — @node(labels) constraints, live Neo4j', () => {
  let driver: Driver;
  const dirs: string[] = [];
  const schema = /* GraphQL */ `
    type ItLbSchemaPerson
      @node(labels: ["ItLbSchemaHuman", "ItLbSchemaEntity"]) {
      id: ID! @id @unique
    }
  `;
  const constraintsOn = async (label: string) =>
    (
      await cypher(
        driver,
        `SHOW CONSTRAINTS YIELD name, labelsOrTypes WHERE $label IN labelsOrTypes RETURN name`,
        { label },
      )
    ).map((r) => r.name as string);
  const dropOurs = async () => {
    for (const r of await cypher(
      driver,
      `SHOW CONSTRAINTS YIELD name WHERE name STARTS WITH 'ItLbSchema' RETURN name`,
    ))
      await cypher(driver, `DROP CONSTRAINT ${r.name as string} IF EXISTS`);
  };

  const push = async (argv: string[]) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'itlb-push-'));
    dirs.push(cwd);
    fs.writeFileSync(path.join(cwd, 'schema.graphql'), schema);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDbPush(['--yes', ...argv], {
      cwd,
      env: {
        NEO4J_URI: SCHEMA_URI!,
        NEO4J_USERNAME: USER,
        NEO4J_PASSWORD: SCHEMA_PASSWORD,
      },
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  beforeAll(async () => {
    driver = neo4j.driver(SCHEMA_URI!, neo4j.auth.basic(USER, SCHEMA_PASSWORD));
    await dropOurs();
  });

  afterAll(async () => {
    await dropOurs();
    expect(
      await cypher(
        driver,
        `SHOW CONSTRAINTS YIELD name WHERE name STARTS WITH 'ItLbSchema' RETURN name`,
      ),
    ).toEqual([]);
    await driver.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('default db push keeps 2.x: the constraint goes on the type name', async () => {
    const res = await push([]);
    expect(res.code).toBe(0);
    expect(res.err).toContain('warning: ItLbSchemaPerson has @node(labels');
    expect(await constraintsOn('ItLbSchemaPerson')).toEqual([
      'ItLbSchemaPerson_id_unique',
    ]);
    expect(await constraintsOn('ItLbSchemaHuman')).toEqual([]);
  });

  it('db push --strict puts it on labels[0] and drops the 2.x one only with --force-drop', async () => {
    const res = await push(['--strict']);
    expect(res.code).toBe(0);
    expect(await constraintsOn('ItLbSchemaHuman')).toEqual([
      'ItLbSchemaHuman_id_unique',
    ]);
    expect(await constraintsOn('ItLbSchemaPerson')).toEqual([
      'ItLbSchemaPerson_id_unique',
    ]);
    expect(res.out).toContain('kept');
    expect((await push(['--strict', '--force-drop'])).code).toBe(0);
    expect(await constraintsOn('ItLbSchemaPerson')).toEqual([]);
    expect(await constraintsOn('ItLbSchemaEntity')).toEqual([]);
  });

  it('the constraint enforces uniqueness for nodes upstream writes', async () => {
    const runId = `lbs${Date.now()}`;
    await cypher(driver, `CREATE (:ItLbSchemaHuman {id: $id, runId: $runId})`, {
      id: `${runId}-x`,
      runId,
    });
    try {
      await expect(
        cypher(driver, `CREATE (:ItLbSchemaHuman {id: $id, runId: $runId})`, {
          id: `${runId}-x`,
          runId,
        }),
      ).rejects.toThrow(/already exists/);
    } finally {
      await cypher(driver, `MATCH (n {runId: $runId}) DETACH DELETE n`, {
        runId,
      });
    }
  });

  it('assertIndexesAndConstraints under strict creates it on labels[0]', async () => {
    await dropOurs();
    const ogm = new OGM({ typeDefs: schema, driver, strict: true });
    await ogm.assertIndexesAndConstraints({ options: { create: true } });
    expect(await constraintsOn('ItLbSchemaHuman')).toEqual([
      'ItLbSchemaHuman_id_unique',
    ]);
    expect(await constraintsOn('ItLbSchemaPerson')).toEqual([]);
  });
});
