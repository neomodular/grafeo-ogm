/**
 * Compiled-Cypher regressions for the v2.5.0 read-path fixes. Each case
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

describe('connection totalCount (v2.5.0)', () => {
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

describe('inline-fragment @cypher fields on abstract types (v2.5.0)', () => {
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

describe('typed select keys ending in "Connection" (v2.5.0)', () => {
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

describe('where value coercion (v2.5.0)', () => {
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
