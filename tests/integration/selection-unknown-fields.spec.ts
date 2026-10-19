/**
 * Live: unknown selectionSet / select field names (v2.6.3, #23).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD). Every node it creates carries this
 * run's `runId` and is removed in `afterAll`.
 *
 * Default mode keeps the v2.6.2 result (a typo comes back null, a
 * `<rel>Aggregate` field is left out) and warns once; `strict: true`
 * throws before anything runs. The alternatives the `<rel>Aggregate`
 * message names return the count.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { Model } from '../../src/model';
import { OGM } from '../../src/ogm';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(120_000);

const typeDefs = /* GraphQL */ `
  type ItUfOwner @node {
    id: ID! @unique
    runId: String
    name: String
    plans: [ItUfPlan!]! @relationship(type: "IT_UF_OWNS", direction: OUT)
  }
  type ItUfPlan @node {
    id: ID! @unique
    runId: String
    name: String
    owners: [ItUfOwner!]! @relationship(type: "IT_UF_OWNS", direction: IN)
  }
`;

type Row = Record<string, unknown>;

describeLive('unknown selected fields — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const planId = `${runId}-plan`;
  let driver: Driver;

  function make(strict?: boolean) {
    const logger = { debug: jest.fn(), warn: jest.fn() };
    const ogm = new OGM({
      typeDefs,
      driver,
      logger,
      ...(strict === undefined ? {} : { strict }),
    });
    return { ogm, logger, plan: ogm.model('ItUfPlan') };
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
    const session = driver.session();
    try {
      await session.run(
        `CREATE (p:ItUfPlan {id: $planId, runId: $runId, name: 'Gold'})
         CREATE (:ItUfOwner {id: $runId + '-a', runId: $runId, name: 'a'})-[:IT_UF_OWNS]->(p)
         CREATE (:ItUfOwner {id: $runId + '-b', runId: $runId, name: 'b'})-[:IT_UF_OWNS]->(p)`,
        { runId, planId },
      );
    } finally {
      await session.close();
    }
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

  beforeEach(() => Model.clearSelectionCache());

  const where = () => ({ id: planId });

  describe('default mode: v2.6.2 result + one warning', () => {
    it('a typo comes back null', async () => {
      const { plan, logger } = make();
      for (let i = 0; i < 2; i++) {
        const rows = (await plan.find({
          where: where(),
          selectionSet: '{ id nmae }',
        })) as Row[];
        expect(rows).toEqual([{ id: planId, nmae: null }]);
      }
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const message = String(logger.warn.mock.calls[0][0]);
      expect(message).toContain(
        'selects "nmae", which is not a field of type "ItUfPlan"',
      );
      expect(message).toContain('Enable `strict: true` (default in 3.0)');
    });

    it('a <rel>Aggregate field is left out', async () => {
      const { plan, logger } = make(false);
      const rows = (await plan.find({
        where: where(),
        selectionSet: '{ id ownersAggregate { count } }',
      })) as Row[];
      expect(rows).toEqual([{ id: planId }]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(String(logger.warn.mock.calls[0][0])).toContain(
        'select "ownersConnection { totalCount }" for a count, or use Model.aggregate() on the related type.',
      );
    });

    it('typed select: an unknown key comes back null', async () => {
      const { plan, logger } = make();
      const rows = (await plan.find({
        where: where(),
        select: { id: true, nmae: true },
      })) as Row[];
      expect(rows).toEqual([{ id: planId, nmae: null }]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('strict: true throws', () => {
    it('a typo', async () => {
      const { plan, logger } = make(true);
      await expect(
        plan.find({ where: where(), selectionSet: '{ id nmae }' }),
      ).rejects.toThrow(
        new OGMError(
          'Unknown field "nmae" in selectionSet on type "ItUfPlan".',
        ),
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('a <rel>Aggregate field', async () => {
      const { plan } = make(true);
      await expect(
        plan.find({
          where: where(),
          selectionSet: '{ id ownersAggregate { count } }',
        }),
      ).rejects.toThrow(
        'Unknown field "ownersAggregate" in selectionSet on type "ItUfPlan". ' +
          '"ownersAggregate" fields are not supported: select "ownersConnection { totalCount }" for a count, ' +
          'or use Model.aggregate() on the related type.',
      );
    });
  });

  describe('the alternatives the message names', () => {
    it.each([undefined, true])(
      'ownersConnection { totalCount } (strict: %s)',
      async (strict) => {
        const { plan, logger } = make(strict);
        const rows = (await plan.find({
          where: where(),
          selectionSet: '{ id ownersConnection { totalCount } }',
        })) as Row[];
        expect(rows).toEqual([
          { id: planId, ownersConnection: { totalCount: 2 } },
        ]);
        expect(logger.warn).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, true])(
      'Model.aggregate() on the related type (strict: %s)',
      async (strict) => {
        const { ogm, logger } = make(strict);
        const result = await ogm.model('ItUfOwner').aggregate({
          where: { plans_SOME: { id: planId } },
          aggregate: { count: true },
        });
        expect(result.count).toBe(2);
        expect(logger.warn).not.toHaveBeenCalled();
      },
    );
  });
});
