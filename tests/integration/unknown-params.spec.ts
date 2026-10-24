/**
 * Live suite — unknown top-level params of Model methods (v2.19.0, strict
 * item 34).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId` and is removed in `afterAll`.
 *
 * Default mode keeps the 2.x behaviour: the param is ignored and one
 * warning is logged, so an upstream-style `update({ where, delete })`
 * deletes nothing, `deleteMany({ where, delete })` does not cascade and
 * `delete({ where, labels })` deletes without the label filter.
 * `strict: true` throws `OGMError` and writes nothing, except that since
 * v2.21.0 (strict item 39) it applies the `labels` of delete / deleteMany,
 * and it applies the root `delete` of `update()` (v2.22.0, strict item 43).
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItUpAuthor @node {
    id: ID! @unique
    runId: String
    posts: [ItUpPost!]! @relationship(type: "IT_UP_WROTE", direction: OUT)
  }
  type ItUpPost @node {
    id: ID! @unique
    runId: String
  }
`;

type Row = Record<string, unknown>;

/** Not a fresh literal, so TypeScript's excess-property check lets it through. */
const extra = <T extends object>(o: T): T => o;

describeLive('Unknown params of Model methods — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let seq = 0;
  let driver: Driver;

  async function run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Row[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { runId, ...params });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  function makeOgm(strict?: boolean) {
    const warnings: string[] = [];
    const ogm = new OGM({
      typeDefs,
      driver,
      logger: { debug: () => {}, warn: (m: string) => warnings.push(m) },
      ...(strict === undefined ? {} : { strict }),
    });
    return { authors: ogm.model('ItUpAuthor'), warnings };
  }

  /** Author `u` (labelled `:ItUpArchived` when asked) with post `a`. */
  async function seed(archived = false) {
    seq++;
    const u = `${runId}-u-${seq}`;
    await run(
      `CREATE (u:ItUpAuthor {id: $u, runId: $runId})
       CREATE (u)-[:IT_UP_WROTE]->(:ItUpPost {id: $a, runId: $runId})
       FOREACH (_ IN CASE WHEN $archived THEN [1] ELSE [] END | SET u:ItUpArchived)`,
      { u, a: `${u}-a`, archived },
    );
    return { u, a: `${u}-a` };
  }

  async function exists(id: string): Promise<boolean> {
    const rows = await run('MATCH (n {id: $id}) RETURN count(n) AS c', { id });
    return rows[0].c === 1;
  }

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
  });

  afterAll(async () => {
    await run(
      'MATCH (n) WHERE (n:ItUpAuthor OR n:ItUpPost) AND n.runId = $runId DETACH DELETE n',
    );
    await driver.close();
  });

  const paramWarnings = (w: string[]) =>
    w.filter((m) => m.includes('Unknown parameter'));

  it('default: update() with a root "delete" deletes nothing and warns once', async () => {
    const { u, a } = await seed();
    const { authors, warnings } = makeOgm();
    await authors.update(
      extra({
        where: { id: u },
        delete: { posts: [{ where: { node: { id: a } } }] },
      }),
    );
    expect(await exists(a)).toBe(true);
    expect(paramWarnings(warnings)).toHaveLength(1);
  });

  it('default: deleteMany() with "delete" does not cascade', async () => {
    const { u, a } = await seed();
    const { authors } = makeOgm();
    await authors.deleteMany(
      extra({ where: { id: u }, delete: { posts: {} } }),
    );
    expect(await exists(u)).toBe(false);
    expect(await exists(a)).toBe(true);
  });

  it('default: delete() with "labels" deletes a node without the label', async () => {
    const { u } = await seed(false);
    const { authors, warnings } = makeOgm();
    await authors.delete(extra({ where: { id: u }, labels: ['ItUpArchived'] }));
    expect(await exists(u)).toBe(false);
    // v2.21.0 — strict item 39 warns instead of item 34.
    expect(paramWarnings(warnings)).toEqual([]);
    expect(
      warnings.filter((m) => m.includes('ignores the runtime "labels"')),
    ).toHaveLength(1);
  });

  it.each(['delete', 'deleteMany'] as const)(
    'strict (v2.21.0, item 39): %s() with "labels" deletes only nodes with the label',
    async (method) => {
      const plain = await seed(false);
      const archived = await seed(true);
      const { authors, warnings } = makeOgm(true);
      const ids = [plain.u, archived.u];
      await authors[method](
        extra({ where: { id_IN: ids }, labels: ['ItUpArchived'] }),
      );
      expect(await exists(plain.u)).toBe(true);
      expect(await exists(archived.u)).toBe(false);
      expect(warnings).toEqual([]);
    },
  );

  it('strict (v2.21.0, item 39): a cascade delete() with "labels" skips an unlabelled root and its posts', async () => {
    const { u, a } = await seed(false);
    const { authors } = makeOgm(true);
    await authors.delete(
      extra({
        where: { id: u },
        delete: { posts: {} },
        labels: ['ItUpArchived'],
      }),
    );
    expect(await exists(u)).toBe(true);
    expect(await exists(a)).toBe(true);
  });

  // v2.22.0 — strict item 43: strict mode applies an upstream root "delete".
  it('strict: update() with a root "delete" deletes the post', async () => {
    const { u, a } = await seed();
    const { authors, warnings } = makeOgm(true);
    await authors.update({
      where: { id: u },
      delete: { posts: [{ where: { node: { id: a } } }] },
    });
    expect(await exists(u)).toBe(true);
    expect(await exists(a)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it.each([
    [
      'deleteMany() with "delete"',
      (m: ReturnType<typeof makeOgm>['authors'], u: string) =>
        m.deleteMany(extra({ where: { id: u }, delete: { posts: {} } })),
    ],
  ])('strict: %s throws and writes nothing', async (_n, fn) => {
    const { u, a } = await seed();
    const { authors, warnings } = makeOgm(true);
    await expect(fn(authors, u)).rejects.toThrow(OGMError);
    expect(await exists(u)).toBe(true);
    expect(await exists(a)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('strict: delete() with a cascade still deletes author and post', async () => {
    const { u, a } = await seed();
    const { authors } = makeOgm(true);
    await authors.delete({ where: { id: u }, delete: { posts: {} } });
    expect(await exists(u)).toBe(false);
    expect(await exists(a)).toBe(false);
  });
});
