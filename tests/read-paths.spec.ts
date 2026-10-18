/**
 * Compiled-Cypher regressions for the v2.5.0 read-path fixes. Each case
 * has a live counterpart under `tests/integration/read-*.spec.ts`; these
 * pin the emitted shape (and cover what can't run live, e.g. APOC).
 */
import type { Driver } from 'neo4j-driver';
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
