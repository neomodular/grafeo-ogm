/**
 * v2.7.1 — connect `overwrite: false` and edge-property `@default` are
 * honoured only in strict mode. In default mode every connect and edge
 * write must compile exactly as before: the Cypher and params below were
 * captured from v2.7.0 (4f6a04a). The cases cover every connect site
 * (top-level single / array fast path / per-item, nested in create and in
 * update, per-member abstract targets, connect-in-connect) and every edge
 * create site, with and without `overwrite: false` and with the defaulted
 * edge property omitted.
 */
import { isInt, type Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';

export const typeDefs = /* GraphQL */ `
  type BiRole @relationshipProperties {
    role: String! @default(value: "member")
    since: Int
  }
  type BiPlain @relationshipProperties {
    note: String
  }
  type BiUser @node {
    id: ID! @unique
    name: String
    teams: [BiTeam!]!
      @relationship(type: "BI_IN", direction: OUT, properties: "BiRole")
    posts: [BiPost!]!
      @relationship(type: "BI_WROTE", direction: OUT, properties: "BiPlain")
    media: [BiMedia!]!
      @relationship(type: "BI_HAS", direction: OUT, properties: "BiRole")
  }
  type BiTeam @node {
    id: ID! @unique
    name: String
    tags: [BiTag!]!
      @relationship(type: "BI_TAGGED", direction: OUT, properties: "BiRole")
  }
  type BiTag @node {
    id: ID! @unique
  }
  type BiPost @node {
    id: ID! @unique
  }
  type BiBook @node {
    id: ID! @unique
  }
  type BiFilm @node {
    id: ID! @unique
  }
  union BiMedia = BiBook | BiFilm
`;

type User = ReturnType<OGM['model']>;

function harness() {
  const session = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: { counters: { updates: () => ({}) } },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  const warnings: string[] = [];
  const ogm = new OGM({
    typeDefs,
    driver,
    logger: { debug: () => {}, warn: (m: string) => void warnings.push(m) },
  });
  return {
    user: ogm.model('BiUser'),
    warnings,
    last: () => {
      const calls = session.run.mock.calls;
      const call = calls[calls.length - 1];
      return {
        cypher: call[0] as string,
        params: call[1] as Record<string, unknown>,
      };
    },
  };
}

/** Params as JSON, neo4j Integers as `{ $int: "<value>" }`. */
const serialize = (params: Record<string, unknown>): unknown =>
  JSON.parse(
    JSON.stringify(params, (_k, v: unknown) =>
      isInt(v) ? { $int: v.toString() } : v,
    ),
  );

const where = { id: 'u1' };
const team = (id: string) => ({ where: { node: { id } } });

export const CASES: Array<[string, (u: User) => Promise<unknown>]> = [
  [
    'connect single, edge, overwrite false',
    (u) =>
      u.update({
        where,
        connect: {
          teams: { ...team('t1'), edge: { role: 'admin' }, overwrite: false },
        },
      }),
  ],
  [
    'connect single, no edge (defaulted rel)',
    (u) => u.update({ where, connect: { teams: team('t1') } }),
  ],
  [
    'connect single, edge without the default',
    (u) =>
      u.update({
        where,
        connect: { teams: { ...team('t1'), edge: { since: 2020 } } },
      }),
  ],
  [
    'connect array fast path, edge, overwrite false',
    (u) =>
      u.update({
        where,
        connect: {
          teams: [
            { ...team('t1'), edge: { role: 'a', since: 1 }, overwrite: false },
            { ...team('t2'), edge: { role: 'b', since: 2 } },
          ],
        },
      }),
  ],
  [
    'connect array fast path, no edge (defaulted rel)',
    (u) => u.update({ where, connect: { teams: [team('t1'), team('t2')] } }),
  ],
  [
    'connect array per-item path, overwrite false',
    (u) =>
      u.update({
        where,
        connect: {
          teams: [
            {
              where: { node: { OR: [{ id: 't1' }, { id: 't2' }] } },
              edge: { role: 'x' },
              overwrite: false,
            },
          ],
        },
      }),
  ],
  [
    'connect, rel without defaults, overwrite false',
    (u) =>
      u.update({
        where,
        connect: {
          posts: [
            {
              where: { node: { id: 'p1' } },
              edge: { note: 'n' },
              overwrite: false,
            },
          ],
        },
      }),
  ],
  [
    'connect per-member union, edge, overwrite false',
    (u) =>
      u.update({
        where,
        connect: {
          media: {
            BiBook: [
              {
                where: { node: { id: 'b1' } },
                edge: { role: 'r' },
                overwrite: false,
              },
            ],
            BiFilm: [{ where: { node: { id: 'f1' } } }],
          },
        },
      }),
  ],
  [
    'connect-in-connect, overwrite false',
    (u) =>
      u.update({
        where,
        connect: {
          teams: [
            {
              ...team('t1'),
              edge: { role: 'lead' },
              overwrite: false,
              connect: [
                {
                  tags: [
                    {
                      where: { node: { id: 'g1' } },
                      edge: { role: 'x' },
                      overwrite: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
  ],
  [
    'create with nested create (no edge) and connect (overwrite false)',
    (u) =>
      u.create({
        input: [
          {
            id: 'u1',
            teams: {
              create: [{ node: { id: 't9', name: 'T' } }],
              connect: [
                { ...team('t1'), edge: { role: 'm' }, overwrite: false },
              ],
            },
            media: { BiBook: { create: [{ node: { id: 'b9' } }] } },
          },
        ],
      }),
  ],
  [
    'create with nested create, edge without the default',
    (u) =>
      u.create({
        input: [
          {
            id: 'u1',
            teams: { create: [{ node: { id: 't9' }, edge: { since: 3 } }] },
          },
        ],
      }),
  ],
  [
    'update nested create (no edge) and connect (overwrite false)',
    (u) =>
      u.update({
        where,
        update: {
          teams: [
            {
              create: [{ node: { id: 't9' } }],
              connect: [
                { ...team('t1'), edge: { role: 'q' }, overwrite: false },
              ],
            },
          ],
        },
      }),
  ],
  [
    'update nested create, edge without the default',
    (u) =>
      u.update({
        where,
        update: {
          teams: [{ create: [{ node: { id: 't9' }, edge: { since: 4 } }] }],
        },
      }),
  ],
];

/** v2.7.0 output for each case. */
const V270: Record<string, { cypher: string; params: unknown }> = {
  'connect single, edge, overwrite false': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target:`BiTeam`)\nWHERE target.`id` = $param1\nMERGE (n)-[r:`BI_IN`]->(target)\nSET r.`role` = $connect_teams_edge_role\nRETURN count(*) AS _conn_teams\n}\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      param1: 't1',
      connect_teams_edge_role: 'admin',
    },
  },
  'connect single, no edge (defaulted rel)': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target:`BiTeam`)\nWHERE target.`id` = $param1\nMERGE (n)-[:`BI_IN`]->(target)\nRETURN count(*) AS _conn_teams\n}\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      param1: 't1',
    },
  },
  'connect single, edge without the default': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target:`BiTeam`)\nWHERE target.`id` = $param1\nMERGE (n)-[r:`BI_IN`]->(target)\nSET r.`since` = $connect_teams_edge_since\nRETURN count(*) AS _conn_teams\n}\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      param1: 't1',
      connect_teams_edge_since: {
        $int: '2020',
      },
    },
  },
  'connect array fast path, edge, overwrite false': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_teams AS connItem\nMATCH (target:`BiTeam`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[r:`BI_IN`]->(target)\nSET r.`role` = connItem.edge.role, r.`since` = connItem.edge.since\nRETURN count(*) AS _conn_teams\n}\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      connect_teams: [
        {
          where: {
            node: {
              id: 't1',
            },
          },
          edge: {
            role: 'a',
            since: {
              $int: '1',
            },
          },
          overwrite: false,
        },
        {
          where: {
            node: {
              id: 't2',
            },
          },
          edge: {
            role: 'b',
            since: {
              $int: '2',
            },
          },
        },
      ],
    },
  },
  'connect array fast path, no edge (defaulted rel)': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_teams AS connItem\nMATCH (target:`BiTeam`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[:`BI_IN`]->(target)\nRETURN count(*) AS _conn_teams\n}\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      connect_teams: [
        {
          where: {
            node: {
              id: 't1',
            },
          },
        },
        {
          where: {
            node: {
              id: 't2',
            },
          },
        },
      ],
    },
  },
  'connect array per-item path, overwrite false': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target_teams_0:`BiTeam`)\nWHERE (target_teams_0.`id` = $param1 OR target_teams_0.`id` = $param2)\nMERGE (n)-[r_conn_teams_0:`BI_IN`]->(target_teams_0)\nSET r_conn_teams_0.`role` = $connect_teams_0_edge_role\nRETURN count(*) AS _ccn_teams_0\n}\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      param1: 't1',
      param2: 't2',
      connect_teams_0_edge_role: 'x',
    },
  },
  'connect, rel without defaults, overwrite false': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_posts AS connItem\nMATCH (target:`BiPost`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[r:`BI_WROTE`]->(target)\nSET r.`note` = connItem.edge.note\nRETURN count(*) AS _conn_posts\n}\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      connect_posts: [
        {
          where: {
            node: {
              id: 'p1',
            },
          },
          edge: {
            note: 'n',
          },
          overwrite: false,
        },
      ],
    },
  },
  'connect per-member union, edge, overwrite false': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nUNWIND $connect_media_BiBook AS connItem\nMATCH (target:`BiBook`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[r:`BI_HAS`]->(target)\nSET r.`role` = connItem.edge.role\nRETURN count(*) AS _conn_media_BiBook\n}\nWITH n\nCALL {\nWITH n\nUNWIND $connect_media_BiFilm AS connItem\nMATCH (target:`BiFilm`)\nWHERE target.`id` = connItem.where.node.id\nMERGE (n)-[:`BI_HAS`]->(target)\nRETURN count(*) AS _conn_media_BiFilm\n}\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      connect_media_BiBook: [
        {
          where: {
            node: {
              id: 'b1',
            },
          },
          edge: {
            role: 'r',
          },
          overwrite: false,
        },
      ],
      connect_media_BiFilm: [
        {
          where: {
            node: {
              id: 'f1',
            },
          },
        },
      ],
    },
  },
  'connect-in-connect, overwrite false': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (target_teams_0:`BiTeam`)\nWHERE target_teams_0.`id` = $param1\nMERGE (n)-[r_conn_teams_0:`BI_IN`]->(target_teams_0)\nSET r_conn_teams_0.`role` = $connect_teams_0_edge_role\nWITH n, target_teams_0\nCALL {\nWITH n, target_teams_0\nUNWIND $connect_teams_0_connect_tags AS connItem\nMATCH (connect_teams_0_target:`BiTag`)\nWHERE connect_teams_0_target.`id` = connItem.where.node.id\nMERGE (target_teams_0)-[connect_teams_0_r:`BI_TAGGED`]->(connect_teams_0_target)\nSET connect_teams_0_r.`role` = connItem.edge.role\nRETURN count(*) AS _conn_connect_teams_0_tags\n}\nRETURN count(*) AS _ccn_teams_0\n}\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      param1: 't1',
      connect_teams_0_edge_role: 'lead',
      connect_teams_0_connect_tags: [
        {
          where: {
            node: {
              id: 'g1',
            },
          },
          edge: {
            role: 'x',
          },
          overwrite: false,
        },
      ],
    },
  },
  'create with nested create (no edge) and connect (overwrite false)': {
    cypher:
      "CREATE (n:`BiUser` { `id`: $create0_id })\nWITH n\nCREATE (n_c0:`BiTeam` { `id`: $create0_teams_create0_id, `name`: $create0_teams_create0_name })\nCREATE (n)-[:`BI_IN`]->(n_c0)\nWITH n\nCALL {\nWITH n\nMATCH (n_cn1:`BiTeam`)\nWHERE n_cn1.`id` = $param0\nMERGE (n)-[r_conn_1:`BI_IN`]->(n_cn1)\nSET r_conn_1.`role` = $create0_teams_conn0_edge_role\nRETURN count(*) AS _ccn_create0_teams_0\n}\nWITH n\nCREATE (n_c2:`BiBook` { `id`: $create0_media_BiBook_create0_id })\nCREATE (n)-[:`BI_HAS`]->(n_c2)\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      create0_id: 'u1',
      create0_teams_create0_id: 't9',
      create0_teams_create0_name: 'T',
      param0: 't1',
      create0_teams_conn0_edge_role: 'm',
      create0_media_BiBook_create0_id: 'b9',
    },
  },
  'create with nested create, edge without the default': {
    cypher:
      "CREATE (n:`BiUser` { `id`: $create0_id })\nWITH n\nCREATE (n_c0:`BiTeam` { `id`: $create0_teams_create0_id })\nCREATE (n)-[:`BI_IN`]->(n_c0)\nWITH n, n_c0\nMATCH (n)-[r_edge_0:`BI_IN`]->(n_c0:`BiTeam`)\nSET r_edge_0.`since` = $create0_teams_create0_edge_since\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      create0_id: 'u1',
      create0_teams_create0_id: 't9',
      create0_teams_create0_edge_since: {
        $int: '3',
      },
    },
  },
  'update nested create (no edge) and connect (overwrite false)': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCALL {\nWITH n\nMATCH (n_conn0:`BiTeam`)\nWHERE n_conn0.`id` = $param1\nMERGE (n)-[r_conn_teams_0:`BI_IN`]->(n_conn0)\nSET r_conn_teams_0.`role` = $update_teams_0_conn0_edge_role\nRETURN count(*) AS _cn_teams_0\n}\nWITH n\nCREATE (n_cr1:`BiTeam` { `id`: $update_teams_0_create0_id })\nCREATE (n)-[:`BI_IN`]->(n_cr1)\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      param1: 't1',
      update_teams_0_conn0_edge_role: 'q',
      update_teams_0_create0_id: 't9',
    },
  },
  'update nested create, edge without the default': {
    cypher:
      "MATCH (n:`BiUser`)\nWHERE n.`id` = $param0\nWITH n\nCREATE (n_cr0:`BiTeam` { `id`: $update_teams_0_create0_id })\nCREATE (n)-[n_cr0_e:`BI_IN`]->(n_cr0)\nSET n_cr0_e.`since` = $update_teams_0_create0_edge_since\nRETURN n { __typename: 'BiUser', .`id`, .`name` }",
    params: {
      param0: 'u1',
      update_teams_0_create0_id: 't9',
      update_teams_0_create0_edge_since: {
        $int: '4',
      },
    },
  },
};

describe('connect / edge writes compile as in v2.7.0 by default (v2.7.1)', () => {
  it.each(CASES)('%s', async (name, call) => {
    const h = harness();
    await call(h.user);
    const { cypher, params } = h.last();
    expect({ cypher, params: serialize(params) }).toEqual(V270[name]);
  });
});
