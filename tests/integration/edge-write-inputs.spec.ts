/**
 * Live suite (v2.7.1): connect `overwrite: false` and edge-property
 * `@default`, both honoured only in strict mode.
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`.
 *
 * For each shape the default OGM keeps the v2.7.0 result and logs one
 * warning; a `strict: true` OGM returns the corrected result.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItEwRole @relationshipProperties {
    role: String! @default(value: "member")
    since: Int
  }
  type ItEwUser @node {
    id: ID! @unique
    runId: String
    teams: [ItEwTeam!]!
      @relationship(type: "IT_EW_IN", direction: OUT, properties: "ItEwRole")
    media: [ItEwMedia!]!
      @relationship(type: "IT_EW_HAS", direction: OUT, properties: "ItEwRole")
  }
  type ItEwTeam @node {
    id: ID! @unique
    runId: String
    tags: [ItEwTag!]!
      @relationship(
        type: "IT_EW_TAGGED"
        direction: OUT
        properties: "ItEwRole"
      )
  }
  type ItEwTag @node {
    id: ID! @unique
    runId: String
  }
  type ItEwBook @node {
    id: ID! @unique
    runId: String
  }
  type ItEwFilm @node {
    id: ID! @unique
    runId: String
  }
  union ItEwMedia = ItEwBook | ItEwFilm
`;

type Row = Record<string, unknown>;
type Model = ReturnType<OGM['model']>;

const OVERWRITE_WARNING = '"overwrite: false" on a connect item of';
const DEFAULT_WARNING = '"ItEwRole.role" declares @default';

describeLive('Edge write inputs — live Neo4j (v2.7.1)', () => {
  const runId = `it-${randomUUID()}`;
  let seq = 0;
  const id = (s: string) => `${runId}-${s}-${seq++}`;
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
      logger: { debug: () => {}, warn: (m: string) => void warnings.push(m) },
      ...(strict === undefined ? {} : { strict }),
    });
    const user = ogm.model('ItEwUser');
    const of = (text: string) => warnings.filter((w) => w.includes(text));
    return { user, warnings, of };
  }

  /** Nodes `(label {id})`, tagged with this run. */
  async function nodes(label: string, ...ids: string[]): Promise<void> {
    await run(`UNWIND $ids AS i CREATE (x:${label} {id: i, runId: $runId})`, {
      ids,
    });
  }

  /** An existing `from -[type {role}]-> to` relationship. */
  async function link(
    from: string,
    type: string,
    to: string,
    role: string | null,
  ): Promise<void> {
    await run(
      `MATCH (a {id: $from}), (b {id: $to})
       CREATE (a)-[r:${type}]->(b) SET r.role = $role`,
      { from, to, role },
    );
  }

  /** Every `from -[type]-> to` relationship's properties. */
  async function edges(from: string, type: string, to: string): Promise<Row[]> {
    const rows = await run(
      `MATCH ({id: $from})-[r:${type}]->({id: $to})
       RETURN r.role AS role, r.since AS since`,
      { from, to },
    );
    return rows;
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
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  describe('connect overwrite: false', () => {
    /**
     * One connect site each. `prepare` seeds the graph so that the connect
     * with `overwrite: false` and `edge: { role: 'new' }` reaches an
     * EXISTING relationship whose role is "old"; `check` names it.
     */
    type Site = {
      name: string;
      field: string;
      go: (u: Model) => Promise<{ from: string; type: string; to: string }>;
    };
    const edge = { role: 'new' };
    const SITES: Site[] = [
      {
        name: 'top-level single connect',
        field: 'teams',
        go: async (u) => {
          const [a, t] = [id('u'), id('t')];
          await nodes('ItEwUser', a);
          await nodes('ItEwTeam', t);
          await link(a, 'IT_EW_IN', t, 'old');
          await u.update({
            where: { id: a },
            connect: {
              teams: { where: { node: { id: t } }, edge, overwrite: false },
            },
          });
          return { from: a, type: 'IT_EW_IN', to: t };
        },
      },
      {
        name: 'top-level array connect (UNWIND fast path by default)',
        field: 'teams',
        go: async (u) => {
          const [a, t, t2] = [id('u'), id('t'), id('t2')];
          await nodes('ItEwUser', a);
          await nodes('ItEwTeam', t, t2);
          await link(a, 'IT_EW_IN', t, 'old');
          await u.update({
            where: { id: a },
            connect: {
              teams: [
                { where: { node: { id: t } }, edge, overwrite: false },
                { where: { node: { id: t2 } }, edge: { role: 'other' } },
              ],
            },
          });
          return { from: a, type: 'IT_EW_IN', to: t };
        },
      },
      {
        name: 'connect nested in update',
        field: 'teams',
        go: async (u) => {
          const [a, t] = [id('u'), id('t')];
          await nodes('ItEwUser', a);
          await nodes('ItEwTeam', t);
          await link(a, 'IT_EW_IN', t, 'old');
          await u.update({
            where: { id: a },
            update: {
              teams: [
                {
                  connect: [
                    { where: { node: { id: t } }, edge, overwrite: false },
                  ],
                },
              ],
            },
          });
          return { from: a, type: 'IT_EW_IN', to: t };
        },
      },
      {
        name: 'connect nested in create (second item reaches the first)',
        field: 'teams',
        go: async (u) => {
          const [a, t] = [id('u'), id('t')];
          await nodes('ItEwTeam', t);
          await u.create({
            input: [
              {
                id: a,
                runId,
                teams: {
                  connect: [
                    { where: { node: { id: t } }, edge: { role: 'old' } },
                    { where: { node: { id: t } }, edge, overwrite: false },
                  ],
                },
              },
            ],
          });
          return { from: a, type: 'IT_EW_IN', to: t };
        },
      },
      {
        name: 'per-member union connect',
        field: 'media',
        go: async (u) => {
          const [a, b] = [id('u'), id('b')];
          await nodes('ItEwUser', a);
          await nodes('ItEwBook', b);
          await link(a, 'IT_EW_HAS', b, 'old');
          await u.update({
            where: { id: a },
            connect: {
              media: {
                ItEwBook: [
                  { where: { node: { id: b } }, edge, overwrite: false },
                ],
              },
            },
          });
          return { from: a, type: 'IT_EW_HAS', to: b };
        },
      },
      {
        name: 'connect-in-connect',
        field: 'tags',
        go: async (u) => {
          const [a, t, g] = [id('u'), id('t'), id('g')];
          await nodes('ItEwUser', a);
          await nodes('ItEwTeam', t);
          await nodes('ItEwTag', g);
          await link(t, 'IT_EW_TAGGED', g, 'old');
          await u.update({
            where: { id: a },
            connect: {
              teams: [
                {
                  where: { node: { id: t } },
                  edge: { role: 'x' },
                  connect: [
                    {
                      tags: [
                        { where: { node: { id: g } }, edge, overwrite: false },
                      ],
                    },
                  ],
                },
              ],
            },
          });
          return { from: t, type: 'IT_EW_TAGGED', to: g };
        },
      },
    ];

    it.each(SITES.map((s) => [s.name, s] as const))(
      'default, %s: the existing edge is overwritten, with one warning',
      async (_n, site) => {
        const { user, of } = makeOgm();
        const { from, type, to } = await site.go(user);
        expect(await edges(from, type, to)).toEqual([
          { role: 'new', since: null },
        ]);
        expect(of(OVERWRITE_WARNING)).toEqual([
          `[OGM] "overwrite: false" on a connect item of "${site.field}" is ignored: when the relationship ` +
            `already exists, its edge properties are overwritten with the item's "edge" values. ` +
            'Enable `strict: true` (default in 3.0) to leave an existing relationship unchanged when "overwrite" is false.',
        ]);
      },
    );

    it.each(SITES.map((s) => [s.name, s] as const))(
      'strict, %s: the existing edge is left unchanged',
      async (_n, site) => {
        const { user, warnings } = makeOgm(true);
        const { from, type, to } = await site.go(user);
        expect(await edges(from, type, to)).toEqual([
          { role: 'old', since: null },
        ]);
        expect(warnings).toEqual([]);
      },
    );

    it.each([false, true])(
      'strict=%s: overwrite: false still creates a missing relationship with its edge values',
      async (strict) => {
        const { user } = makeOgm(strict);
        const [a, t] = [id('u'), id('t')];
        await nodes('ItEwUser', a);
        await nodes('ItEwTeam', t);
        await user.update({
          where: { id: a },
          connect: {
            teams: [
              {
                where: { node: { id: t } },
                edge: { role: 'new', since: 7 },
                overwrite: false,
              },
            ],
          },
        });
        expect(await edges(a, 'IT_EW_IN', t)).toEqual([
          { role: 'new', since: 7 },
        ]);
      },
    );

    it('default: overwrite: false without edge values does not warn', async () => {
      const { user, of } = makeOgm();
      const [a, t] = [id('u'), id('t')];
      await nodes('ItEwUser', a);
      await nodes('ItEwTeam', t);
      await link(a, 'IT_EW_IN', t, 'old');
      await user.update({
        where: { id: a },
        connect: { teams: [{ where: { node: { id: t } }, overwrite: false }] },
      });
      expect(await edges(a, 'IT_EW_IN', t)).toEqual([
        { role: 'old', since: null },
      ]);
      expect(of(OVERWRITE_WARNING)).toEqual([]);
    });
  });

  describe('edge-property @default', () => {
    /** One edge-creating site each, none naming `role` in its edge input. */
    type Site = {
      name: string;
      go: (u: Model) => Promise<{ from: string; type: string; to: string }>;
    };
    const SITES: Site[] = [
      {
        name: 'nested create in create, no edge input',
        go: async (u) => {
          const [a, t] = [id('u'), id('t')];
          await u.create({
            input: [
              {
                id: a,
                runId,
                teams: { create: [{ node: { id: t, runId } }] },
              },
            ],
          });
          return { from: a, type: 'IT_EW_IN', to: t };
        },
      },
      {
        name: 'nested create in create, edge without the field',
        go: async (u) => {
          const [a, b] = [id('u'), id('b')];
          await u.create({
            input: [
              {
                id: a,
                runId,
                media: {
                  ItEwBook: {
                    create: [{ node: { id: b, runId }, edge: { since: 3 } }],
                  },
                },
              },
            ],
          });
          return { from: a, type: 'IT_EW_HAS', to: b };
        },
      },
      {
        name: 'nested create in update',
        go: async (u) => {
          const [a, t] = [id('u'), id('t')];
          await nodes('ItEwUser', a);
          await u.update({
            where: { id: a },
            update: {
              teams: [
                { create: [{ node: { id: t, runId }, edge: { since: 3 } }] },
              ],
            },
          });
          return { from: a, type: 'IT_EW_IN', to: t };
        },
      },
      {
        name: 'single connect',
        go: async (u) => {
          const [a, t] = [id('u'), id('t')];
          await nodes('ItEwUser', a);
          await nodes('ItEwTeam', t);
          await u.update({
            where: { id: a },
            connect: { teams: { where: { node: { id: t } } } },
          });
          return { from: a, type: 'IT_EW_IN', to: t };
        },
      },
      {
        name: 'array connect (UNWIND fast path)',
        go: async (u) => {
          const [a, t] = [id('u'), id('t')];
          await nodes('ItEwUser', a);
          await nodes('ItEwTeam', t);
          await u.update({
            where: { id: a },
            connect: {
              teams: [{ where: { node: { id: t } }, edge: { since: 3 } }],
            },
          });
          return { from: a, type: 'IT_EW_IN', to: t };
        },
      },
      {
        name: 'connect nested in create',
        go: async (u) => {
          const [a, t] = [id('u'), id('t')];
          await nodes('ItEwTeam', t);
          await u.create({
            input: [
              {
                id: a,
                runId,
                teams: { connect: [{ where: { node: { id: t } } }] },
              },
            ],
          });
          return { from: a, type: 'IT_EW_IN', to: t };
        },
      },
      {
        name: 'connect-in-connect',
        go: async (u) => {
          const [a, t, g] = [id('u'), id('t'), id('g')];
          await nodes('ItEwUser', a);
          await nodes('ItEwTeam', t);
          await nodes('ItEwTag', g);
          await u.update({
            where: { id: a },
            connect: {
              teams: [
                {
                  where: { node: { id: t } },
                  edge: { role: 'lead' },
                  connect: [{ tags: [{ where: { node: { id: g } } }] }],
                },
              ],
            },
          });
          return { from: t, type: 'IT_EW_TAGGED', to: g };
        },
      },
    ];

    it.each(SITES.map((s) => [s.name, s] as const))(
      'default, %s: the property is left unset, with one warning',
      async (_n, site) => {
        const { user, of } = makeOgm();
        const { from, type, to } = await site.go(user);
        const [edge] = await edges(from, type, to);
        expect(edge.role).toBeNull();
        expect(of(DEFAULT_WARNING)).toHaveLength(1);
        expect(of(DEFAULT_WARNING)[0]).toMatch(
          /^\[OGM\] "ItEwRole\.role" declares @default, but a relationship created without it \(edge input of "\w+"\) is stored with no "role" property\. Enable `strict: true` \(default in 3\.0\) to apply @default values of relationship properties when the relationship is created\.$/,
        );
      },
    );

    it.each(SITES.map((s) => [s.name, s] as const))(
      'strict, %s: the default is stored',
      async (_n, site) => {
        const { user, warnings } = makeOgm(true);
        const { from, type, to } = await site.go(user);
        const [edge] = await edges(from, type, to);
        expect(edge.role).toBe('member');
        expect(warnings).toEqual([]);
      },
    );

    it('default: warns once per type and field across calls and sites', async () => {
      const { user, of } = makeOgm();
      for (const site of SITES.slice(0, 3)) await site.go(user);
      expect(of(DEFAULT_WARNING)).toHaveLength(1);
    });

    it('strict: a connect to an EXISTING relationship keeps its value', async () => {
      const { user } = makeOgm(true);
      const [a, t] = [id('u'), id('t')];
      await nodes('ItEwUser', a);
      await nodes('ItEwTeam', t);
      await link(a, 'IT_EW_IN', t, null);
      await user.update({
        where: { id: a },
        connect: { teams: { where: { node: { id: t } }, edge: { since: 9 } } },
      });
      expect(await edges(a, 'IT_EW_IN', t)).toEqual([{ role: null, since: 9 }]);
    });

    it('strict: an explicit null is kept', async () => {
      const { user } = makeOgm(true);
      const [a, t] = [id('u'), id('t')];
      await nodes('ItEwUser', a);
      await nodes('ItEwTeam', t);
      await user.update({
        where: { id: a },
        connect: {
          teams: { where: { node: { id: t } }, edge: { role: null } },
        },
      });
      expect(await edges(a, 'IT_EW_IN', t)).toEqual([
        { role: null, since: null },
      ]);
    });

    it('strict: an edge update never applies the default', async () => {
      const { user, warnings } = makeOgm(true);
      const [a, t] = [id('u'), id('t')];
      await nodes('ItEwUser', a);
      await nodes('ItEwTeam', t);
      await link(a, 'IT_EW_IN', t, null);
      await user.update({
        where: { id: a },
        update: {
          teams: [
            { where: { node: { id: t } }, update: { edge: { since: 5 } } },
          ],
        },
      });
      expect(await edges(a, 'IT_EW_IN', t)).toEqual([{ role: null, since: 5 }]);
      expect(warnings).toEqual([]);
    });
  });
});
