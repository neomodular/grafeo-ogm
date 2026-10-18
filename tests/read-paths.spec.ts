/**
 * Compiled-Cypher regressions for the v2.4.8 read-path fixes. Each case
 * has a live counterpart under `tests/integration/read-*.spec.ts`; these
 * pin the emitted shape (and cover what can't run live, e.g. APOC).
 */
import { isInt, type Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { policies, typeDefs } from './fixtures/read-paths.fixture';

function mockDriver() {
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
  return { driver, session };
}

const last = (calls: unknown[][]) => calls[calls.length - 1];

function harness(withPolicies = false) {
  const { driver, session } = mockDriver();
  const ogm = new OGM({
    typeDefs,
    driver,
    ...(withPolicies ? { policies } : {}),
  });
  const bound = withPolicies ? ogm.withContext({}) : ogm;
  return {
    model: (name: string) => bound.model(name),
    iface: (name: string) => bound.interfaceModel(name),
    cypher: () => last(session.run.mock.calls)[0] as string,
    params: () => last(session.run.mock.calls)[1] as Record<string, unknown>,
  };
}

describe('connection totalCount (v2.4.8)', () => {
  it('selectionSet totalCount + edges share one filtered comprehension', async () => {
    const h = harness(true);
    await h.model('LbUser').find({
      selectionSet: '{ postsConnection { totalCount edges { node { id } } } }',
    });
    const pattern =
      '(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) WHERE (true AND (n0.`secret` = $param0))';
    expect(h.cypher()).toContain(
      `postsConnection: { edges: [${pattern} | { node: n0 { .\`id\` } }], totalCount: size([${pattern} | 1]) }`,
    );
  });

  it('totalCount alone projects only totalCount', async () => {
    const h = harness();
    await h
      .model('LbUser')
      .find({ selectionSet: '{ postsConnection { totalCount } }' });
    expect(h.cypher()).toContain(
      'postsConnection: { totalCount: size([(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | 1]) }',
    );
  });

  it('typed select totalCount', async () => {
    const h = harness();
    await h.model('LbUser').find({
      select: {
        postsConnection: {
          where: { edge: { stars: 5 } },
          select: { totalCount: true },
        },
      },
    } as never);
    expect(h.cypher()).toMatch(
      /postsConnection: \{ totalCount: size\(\[\(n\)-\[e0:`LB_WROTE`\]->\(n0:`LbPost`\) WHERE e0\.`stars` = \$\w+ \| 1\]\) \}/,
    );
  });

  it('without totalCount the projection is unchanged', async () => {
    const h = harness();
    await h
      .model('LbUser')
      .find({ selectionSet: '{ postsConnection { edges { node { id } } } }' });
    expect(h.cypher()).toContain(
      'postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` } }] } }',
    );
  });
});

describe('inline-fragment @cypher fields on abstract types (v2.4.8)', () => {
  it("InterfaceModel projects an implementer's @cypher field under a label guard", async () => {
    const h = harness();
    await h
      .iface('LbThing')
      .find({ selectionSet: '{ id ... on LbDoc { dcount } }' });
    const cypher = h.cypher();
    expect(cypher).toContain('  WITH n WHERE n:`LbDoc`\n  CALL {');
    expect(cypher).toContain('`dcount` AS __sel_n_LbDoc_dcount');
    expect(cypher).toContain(
      '`dcount`: CASE WHEN n:`LbDoc` THEN __sel_n_LbDoc_dcount END',
    );
  });

  it('stored fragment fields keep the plain projection', async () => {
    const h = harness();
    await h.iface('LbThing').find({
      selectionSet: '{ id ... on LbPost { title } }',
    });
    expect(h.cypher()).toContain('.`id`, .`title` , __typename: __typename }');
  });

  it('nested interface targets project inline under CASE', async () => {
    const h = harness();
    await h.model('LbUser').find({
      selectionSet: '{ things { ... on LbDoc { dcount } } }',
    });
    expect(h.cypher()).toContain(
      '`dcount`: CASE WHEN n0:`LbDoc` THEN head(COLLECT { WITH n0 AS this\n  RETURN this.rank * 10 AS dcount\n}) END',
    );
  });

  it('a field selected both directly and in a fragment is unconditional', async () => {
    const h = harness();
    await h.iface('LbThing').find({
      selectionSet: '{ ... on LbDoc { rank } rank }',
    });
    expect(h.cypher()).toContain(
      "'LbDoc']]), .`rank` , __typename: __typename }",
    );
  });
});

describe('typed select keys ending in "Connection" (v2.4.8)', () => {
  it('a scalar named *Connection is selected as a scalar', async () => {
    const h = harness();
    await h.model('LbUser').find({
      select: { id: true, internetConnection: true },
    } as never);
    expect(h.cypher()).toContain('RETURN n { .`id`, .`internetConnection` }');
  });

  it('a relationship connection is still a connection', async () => {
    const h = harness();
    await h.model('LbUser').find({
      select: {
        postsConnection: {
          select: { edges: { node: { select: { id: true } } } },
        },
      },
    } as never);
    expect(h.cypher()).toContain(
      'postsConnection: { edges: [(n)-[e0:`LB_WROTE`]->(n0:`LbPost`) | { node: n0 { .`id` } }] }',
    );
  });
});

describe('nested relationship orderBy (v2.4.8)', () => {
  // Verified by shape only: the live test database has no APOC.
  it('sorts on synthetic keys and strips them', async () => {
    const h = harness();
    await h.model('LbUser').find({
      select: {
        posts: {
          select: { id: true },
          orderBy: [{ rank: 'DESC' }, { title: 'ASC' }],
        },
      },
    } as never);
    expect(h.cypher()).toContain(
      "posts: [__sk IN apoc.coll.sortMulti([(n)-[:`LB_WROTE`]->(n0:`LbPost`) | { __node: n0 { .`id` }, __sk0: n0.`rank`, __sk1: n0.`title` }], ['__sk0', '^__sk1']) | __sk.__node]",
    );
  });

  it('keeps the read policy inside the sorted comprehension', async () => {
    const h = harness(true);
    await h.model('LbUser').find({
      select: { posts: { select: { id: true }, orderBy: { rank: 'ASC' } } },
    } as never);
    expect(h.cypher()).toContain(
      "posts: [__sk IN apoc.coll.sortMulti([(n)-[:`LB_WROTE`]->(n0:`LbPost`) WHERE (true AND (n0.`secret` = $param0)) | { __node: n0 { .`id` }, __sk0: n0.`rank` }], ['^__sk0']) | __sk.__node]",
    );
  });
});

describe('aggregate on @cypher fields (v2.4.8)', () => {
  it('Model.aggregate refuses a @cypher field by name', async () => {
    const h = harness();
    await expect(
      h.model('LbUser').aggregate({ aggregate: { postCount: true } } as never),
    ).rejects.toThrow(/Cannot aggregate @cypher field "LbUser\.postCount"/);
  });

  it('Model.aggregate on stored fields is unchanged', async () => {
    const h = harness();
    await h.model('LbUser').aggregate({ aggregate: { count: true } } as never);
    expect(h.cypher()).toBe('MATCH (n:`LbUser`)\nRETURN count(n) AS count');
  });

  it('InterfaceModel.aggregate refuses an interface @cypher field', async () => {
    const { driver } = mockDriver();
    const ogm = new OGM({
      driver,
      typeDefs: /* GraphQL */ `
        interface LbScored {
          id: ID!
          score: Int
            @cypher(statement: "RETURN 1 AS score", columnName: "score")
        }
        type LbA implements LbScored @node {
          id: ID!
          score: Int
            @cypher(statement: "RETURN 1 AS score", columnName: "score")
        }
      `,
    });
    await expect(
      ogm.interfaceModel('LbScored').aggregate({ aggregate: { score: true } }),
    ).rejects.toThrow(/Cannot aggregate @cypher field "LbScored\.score"/);
  });
});

describe('where value coercion (v2.4.8)', () => {
  it('binds BigInt strings and bigints as Neo4j Integers', async () => {
    const h = harness();
    await h.model('LbUser').find({
      where: { big: '9007199254740993', big_IN: ['1', 2n], big_GT: 3 },
    } as never);
    const p = h.params();
    expect(isInt(p.param0)).toBe(true);
    expect((p.param0 as { toString(): string }).toString()).toBe(
      '9007199254740993',
    );
    expect((p.param1 as unknown[]).every((v) => isInt(v))).toBe(true);
    // Plain numbers keep their shape: Neo4j compares Float and Long
    // numerically.
    expect(p.param2).toBe(3);
  });

  it('rejects a non-integer string for a BigInt filter', async () => {
    const h = harness();
    await expect(
      h.model('LbUser').find({ where: { big: '12abc' } } as never),
    ).rejects.toThrow(/Expected an integer for BigInt field "big"/);
  });

  it('binds a JS Date for a DateTime filter as datetime(<ISO>)', async () => {
    const h = harness();
    await h.model('LbUser').find({
      where: { at_GTE: new Date('2024-01-15T10:30:00Z') },
    } as never);
    expect(h.cypher()).toContain('n.`at` >= datetime($param0)');
    expect(h.params().param0).toBe('2024-01-15T10:30:00.000Z');
  });

  it('leaves string operators alone', async () => {
    const h = harness();
    await h.model('LbUser').find({ where: { name_CONTAINS: '5' } } as never);
    expect(h.params().param0).toBe('5');
  });
});

describe('selectionSet arguments and aliases (v2.5.0)', () => {
  it('binds relationship where arguments as parameters, with the read policy', async () => {
    const h = harness(true);
    await h.model('LbUser').find({
      selectionSet: '{ posts(where: { title: "x\' OR 1=1" }) { id } }',
    });
    expect(h.cypher()).toContain(
      'posts: [(n)-[:`LB_WROTE`]->(n0:`LbPost`) WHERE (n0.`title` = $param0) AND (true AND (n0.`secret` = $param1)) | n0 { .`id` }]',
    );
    expect(h.params().param0).toBe("x' OR 1=1");
  });

  it('options.sort / offset / limit sort then slice with bound bounds', async () => {
    const h = harness();
    await h.model('LbUser').find({
      selectionSet:
        '{ posts(options: { sort: [{ rank: DESC }], offset: 2, limit: 5 }) { id } }',
    });
    expect(h.cypher()).toContain(
      "posts: [__sk IN apoc.coll.sortMulti([(n)-[:`LB_WROTE`]->(n0:`LbPost`) | { __node: n0 { .`id` }, __sk0: n0.`rank` }], ['__sk0']) | __sk.__node][$sel_param0..$sel_param1]",
    );
    const p = h.params();
    expect(String(p.sel_param0)).toBe('2');
    expect(String(p.sel_param1)).toBe('7');
  });

  it('limit alone slices from the start', async () => {
    const h = harness();
    await h.model('LbUser').find({
      selectionSet: '{ posts(options: { limit: 3 }) { id } }',
    });
    expect(h.cypher()).toContain('| n0 { .`id` }][..$sel_param0]');
  });

  it('aliases become output keys and keep duplicate fields apart', async () => {
    const h = harness();
    await h.model('LbUser').find({
      selectionSet:
        '{ ident: id id a: posts { id } b: posts(where: { rank: 1 }) { r: rank } }',
    });
    const cypher = h.cypher();
    expect(cypher).toContain('RETURN n { `ident`: n.`id`, .`id`, a: [');
    expect(cypher).toContain(
      'b: [(n)-[:`LB_WROTE`]->(n0:`LbPost`) WHERE n0.`rank` = $param0 | n0 { `r`: n0.`rank` }]',
    );
  });

  it('rejects an unknown sort field', async () => {
    const h = harness();
    await expect(
      h.model('LbUser').find({
        selectionSet: '{ posts(options: { sort: [{ nope: ASC }] }) { id } }',
      }),
    ).rejects.toThrow(/Invalid sort field "nope"/);
  });

  it('rejects options on a singular relationship', async () => {
    const h = harness();
    await expect(
      h.model('LbPost').find({
        selectionSet: '{ author(options: { limit: 1 }) { id } }',
      }),
    ).rejects.toThrow(/singular relationship "author"/);
  });

  it('rejects arguments on connection sub-fields', async () => {
    const h = harness();
    await expect(
      h.model('LbUser').find({
        selectionSet: '{ postsConnection { edges(first: 1) { node { id } } } }',
      }),
    ).rejects.toThrow(
      /Unsupported argument "first" on "postsConnection\.edges"/,
    );
  });
});
