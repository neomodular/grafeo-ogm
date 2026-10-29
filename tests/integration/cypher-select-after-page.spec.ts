/**
 * Live suite, strict item 49 (2.24.0): with `strict: true` a selected
 * `@cypher` field is projected after ORDER BY / SKIP / LIMIT when the query
 * sorts and pages. Every case runs on a default and a strict OGM and pins
 * that the page is the same rows in the same order with the same values,
 * checked against a JS oracle (every sort has a unique tiebreak: rows
 * tied on the whole sort key have no defined order in Cypher), including
 * a statement returning no row (null), one returning several rows (first
 * row), a sort on another `@cypher` field, an interface model and a
 * policy-bound model.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver, Integer } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  interface ItSapThing {
    id: ID!
    runId: String
    rank: Int
    posts: Int
      @cypher(
        statement: "MATCH (this)-[:IT_SAP_WROTE]->(p) RETURN count(p) AS c"
        columnName: "c"
      )
  }
  type ItSapUser implements ItSapThing @node {
    id: ID! @unique
    runId: String
    rank: Int
    grp: Int
    tenant: String
    posts: Int
      @cypher(
        statement: "MATCH (this)-[:IT_SAP_WROTE]->(p) RETURN count(p) AS c"
        columnName: "c"
      )
    firstTitle: String
      @cypher(
        statement: "MATCH (this)-[:IT_SAP_WROTE]->(p) RETURN p.title AS t ORDER BY p.title"
        columnName: "t"
      )
  }
`;

type Row = Record<string, unknown>;
const N = 30;

describeLive('@cypher SELECT after paging — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;
  let ogm: OGM;
  let strictOgm: OGM;
  let policyOgm: OGM;
  let strictPolicyOgm: OGM;
  const both = () => [ogm, strictOgm];
  // oracle: user i has rank (i * 7) % N (unique), grp i % 3, i % 5 posts
  const users = Array.from({ length: N }, (_, i) => ({
    id: `${runId}-u${String(i).padStart(2, '0')}`,
    rank: (i * 7) % N,
    grp: i % 3,
    tenant: i % 2 ? 'a' : 'b',
    posts: i % 5,
    firstTitle: i % 5 ? `t${i}-0` : null,
  }));

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
    );
    ogm = new OGM({ typeDefs, driver });
    strictOgm = new OGM({ typeDefs, driver, strict: true });
    const policies = {
      ItSapUser: [
        permissive({
          operations: ['read'],
          name: 'tenant',
          when: () => ({ tenant: 'a' }),
        }),
      ],
    };
    policyOgm = new OGM({ typeDefs, driver, policies });
    strictPolicyOgm = new OGM({ typeDefs, driver, policies, strict: true });
    const session = driver.session();
    try {
      await session.run(
        `UNWIND $users AS u
         CREATE (n:ItSapUser {id: u.id, runId: $runId, rank: u.rank, grp: u.grp, tenant: u.tenant})
         WITH n, u UNWIND range(0, u.posts - 1) AS j
         CREATE (n)-[:IT_SAP_WROTE]->(:ItSapPost {runId: $runId, title: 't' + toString(toInteger(split(u.id, '-u')[1])) + '-' + j})`,
        {
          runId,
          users: users.map((u) => ({ ...u, posts: neo4j.int(u.posts) })),
        },
      );
    } finally {
      await session.close();
    }
  });

  afterAll(async () => {
    const session = driver.session();
    try {
      await session.run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n', {
        runId,
      });
    } finally {
      await session.close();
    }
    await driver.close();
  });

  const plain = (rows: Row[]) =>
    rows.map((r) => {
      const o: Row = {};
      for (const [k, v] of Object.entries(r))
        o[k] = neo4j.isInt(v) ? (v as Integer).toNumber() : v;
      return o;
    });

  it('sort on a stored field + SKIP / LIMIT', async () => {
    for (const o of both()) {
      const rows = await o.model('ItSapUser').find({
        where: { runId },
        options: { sort: [{ rank: 'DESC' }], offset: 4, limit: 7 },
        selectionSet: '{ id posts firstTitle }',
      });
      const expected = [...users]
        .sort((a, b) => b.rank - a.rank)
        .slice(4, 11)
        .map(({ id, posts, firstTitle }) => ({ id, posts, firstTitle }));
      expect(plain(rows as Row[])).toEqual(expected);
    }
  });

  it('sort on one @cypher field, another @cypher field selected', async () => {
    for (const o of both()) {
      const rows = await o.model('ItSapUser').find({
        where: { runId },
        options: { sort: [{ posts: 'DESC' }, { id: 'ASC' }], limit: 9 },
        selectionSet: '{ id firstTitle }',
      });
      const expected = [...users]
        .sort((a, b) => b.posts - a.posts || (a.id < b.id ? -1 : 1))
        .slice(0, 9)
        .map(({ id, firstTitle }) => ({ id, firstTitle }));
      expect(plain(rows as Row[])).toEqual(expected);
    }
  });

  it('the same @cypher field sorted on and selected', async () => {
    for (const o of both()) {
      const rows = await o.model('ItSapUser').find({
        where: { runId, grp: 1 },
        options: { sort: [{ posts: 'ASC' }, { rank: 'ASC' }], offset: 1 },
        selectionSet: '{ id posts }',
      });
      const expected = users
        .filter((u) => u.grp === 1)
        .sort((a, b) => a.posts - b.posts || a.rank - b.rank)
        .slice(1)
        .map(({ id, posts }) => ({ id, posts }));
      expect(plain(rows as Row[])).toEqual(expected);
    }
  });

  it('InterfaceModel: sort + LIMIT with a @cypher field selected', async () => {
    for (const o of both()) {
      const rows = await o.interfaceModel('ItSapThing').find({
        where: { runId },
        options: { sort: [{ rank: 'ASC' }], limit: 5 },
        selectionSet: '{ id posts }',
      } as never);
      const expected = [...users]
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 5)
        .map(({ id, posts }) => ({ __typename: 'ItSapUser', id, posts }));
      expect(
        plain(rows as Row[]).map((r) => ({
          __typename: r.__typename,
          id: r.id,
          posts: r.posts,
        })),
      ).toEqual(expected);
    }
  });

  it('policy-bound: the read policy filters before paging', async () => {
    for (const o of [policyOgm, strictPolicyOgm]) {
      const rows = await o
        .withContext({})
        .model('ItSapUser')
        .find({
          where: { runId },
          options: { sort: [{ rank: 'ASC' }], offset: 2, limit: 4 },
          selectionSet: '{ id posts }',
        });
      const expected = users
        .filter((u) => u.tenant === 'a')
        .sort((a, b) => a.rank - b.rank)
        .slice(2, 6)
        .map(({ id, posts }) => ({ id, posts }));
      expect(plain(rows as Row[])).toEqual(expected);
    }
  });
});
