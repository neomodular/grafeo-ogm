/**
 * Live suite, strict item 50 (vNEXT): on an OGM configured with
 * `policies`, a bare `ogm.model()` applies no policy. Default mode keeps
 * that (it returns rows the read policy hides, and warns once); strict
 * mode refuses the lookup; `withContext` and `unsafe.bypassPolicies()`
 * behave as before in both modes.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { OGM } from '../../src/ogm';
import { permissive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = /* GraphQL */ `
  type ItMwcDoc @node {
    id: ID! @unique
    runId: String
    tenant: String
  }
`;

describeLive('Bare model() on a policy-configured OGM — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  let driver: Driver;
  const policies = {
    ItMwcDoc: [
      permissive({
        operations: ['read'],
        name: 'tenant',
        when: () => ({ tenant: 't1' }),
      }),
    ],
  };
  const ids = (rows: unknown[]) =>
    (rows as { id: string }[]).map((r) => r.id).sort();

  beforeAll(async () => {
    driver = neo4j.driver(
      URI!,
      neo4j.auth.basic(
        process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? 'neo4j',
        process.env.NEO4J_PASSWORD ?? 'password',
      ),
    );
    const s = driver.session();
    try {
      await s.run(
        `CREATE (:ItMwcDoc {id: $runId + '-a', runId: $runId, tenant: 't1'}),
                (:ItMwcDoc {id: $runId + '-b', runId: $runId, tenant: 't2'})`,
        { runId },
      );
    } finally {
      await s.close();
    }
  });

  afterAll(async () => {
    const s = driver.session();
    try {
      await s.run('MATCH (n:ItMwcDoc {runId: $runId}) DETACH DELETE n', {
        runId,
      });
    } finally {
      await s.close();
    }
    await driver.close();
  });

  it('default mode: no policy applies, and it warns once', async () => {
    const warn = jest.fn();
    const ogm = new OGM({
      typeDefs,
      driver,
      policies,
      logger: { debug: () => {}, warn },
    });
    const find = () =>
      ogm.model('ItMwcDoc').find({ where: { runId }, selectionSet: '{ id }' });
    expect(ids(await find())).toEqual([`${runId}-a`, `${runId}-b`]);
    await find();
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('applies no policy')),
    ).toHaveLength(1);
    const bound = await ogm
      .withContext({})
      .model('ItMwcDoc')
      .find({ where: { runId }, selectionSet: '{ id }' });
    expect(ids(bound)).toEqual([`${runId}-a`]);
  });

  it('strict mode: the bare lookup throws; withContext and bypass work', async () => {
    const ogm = new OGM({ typeDefs, driver, policies, strict: true });
    expect(() => ogm.model('ItMwcDoc')).toThrow(OGMError);
    const bound = await ogm
      .withContext({})
      .model('ItMwcDoc')
      .find({ where: { runId }, selectionSet: '{ id }' });
    expect(ids(bound)).toEqual([`${runId}-a`]);
    const system = await ogm.unsafe
      .bypassPolicies()
      .model('ItMwcDoc')
      .find({ where: { runId }, selectionSet: '{ id }' });
    expect(ids(system)).toEqual([`${runId}-a`, `${runId}-b`]);
  });
});
