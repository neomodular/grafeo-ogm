/**
 * Live NLS enforcement suite (fix-nls-enforcement-gaps, v2.3.0).
 *
 * Opt-in: runs only when NEO4J_URI is set (credentials from NEO4J_USER /
 * NEO4J_USERNAME and NEO4J_PASSWORD, as in `examples/`). Every node it
 * creates carries this run's `runId` and is removed in `afterAll`, so it
 * is safe to point at a shared development database.
 *
 * Each scenario asserts a DATABASE OUTCOME (rows returned, nodes left,
 * relationships created, error raised) for one enforcement gap. They
 * were written to FAIL on v2.2.0 — proving the hole — and pass once the
 * corresponding fix lands.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { OGMError } from '../../src/errors';
import { PolicyDeniedError } from '../../src/policy/errors';
import {
  CTX,
  policies,
  typeDefs,
  type Ctx,
} from '../fixtures/nls-enforcement.fixture';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

describeLive('NLS enforcement — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (suffix: string) => `${runId}-${suffix}`;
  let driver: Driver;
  let ogm: OGM;

  async function run(
    cypher: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>[]> {
    const session = driver.session();
    try {
      const res = await session.run(cypher, { runId, ...params });
      return res.records.map((r) => r.toObject());
    } finally {
      await session.close();
    }
  }

  async function exists(nodeId: string): Promise<boolean> {
    const rows = await run('MATCH (n {id: $nodeId}) RETURN count(n) AS c', {
      nodeId,
    });
    return Number(rows[0].c) > 0;
  }

  async function linked(
    fromId: string,
    type: string,
    toId: string,
  ): Promise<boolean> {
    const rows = await run(
      `MATCH ({id: $fromId})-[r:\`${type}\`]->({id: $toId}) RETURN count(r) AS c`,
      { fromId, toId },
    );
    return Number(rows[0].c) > 0;
  }

  const bound = (ctx: Ctx = CTX) => ogm.withContext(ctx);

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
    ogm = new OGM({ typeDefs, driver, policies });
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  // --- H1: unprotected root is not a gateway -----------------------------

  describe('H1 — unprotected root', () => {
    beforeAll(async () => {
      await run(
        `CREATE (t:ItTag {id: $t, runId: $runId})
         CREATE (pub:ItResource:ItChart {id: $pub, runId: $runId, secret: false, ownerId: 'u1', tenantId: 't1'})
         CREATE (sec:ItResource:ItChart {id: $sec, runId: $runId, secret: true, ownerId: 'u1', tenantId: 't1'})
         CREATE (t)-[:IT_TAGS]->(pub), (t)-[:IT_TAGS]->(sec)
         CREATE (:ItTag {id: $t2, runId: $runId})
         CREATE (:ItResource:ItChart {id: $sec2, runId: $runId, secret: true, ownerId: 'u1', tenantId: 't1'})`,
        {
          t: id('h1-tag'),
          pub: id('h1-pub'),
          sec: id('h1-sec'),
          t2: id('h1-tag2'),
          sec2: id('h1-sec2'),
        },
      );
    });

    it('nested selection hides policy-protected charts', async () => {
      const [tag] = await bound()
        .model('ItTag')
        .find({
          where: { id: id('h1-tag') },
          select: { id: true, charts: { select: { id: true } } },
        });
      const chartIds = (tag.charts as { id: string }[]).map((c) => c.id);
      expect(chartIds).toEqual([id('h1-pub')]);
    });

    it('traversal filters cannot match through hidden charts', async () => {
      const tags = await bound()
        .model('ItTag')
        .find({ where: { charts_SOME: { id: id('h1-sec') } } });
      expect(tags).toEqual([]);
    });

    it('connect (update) cannot link a hidden chart', async () => {
      await bound()
        .model('ItTag')
        .update({
          where: { id: id('h1-tag2') },
          connect: { charts: [{ where: { node: { id: id('h1-sec2') } } }] },
        });
      expect(await linked(id('h1-tag2'), 'IT_TAGS', id('h1-sec2'))).toBe(false);
    });

    it('connect inside create cannot link a hidden chart', async () => {
      await bound()
        .model('ItTag')
        .create({
          input: [
            {
              id: id('h1-tag3'),
              runId,
              charts: { connect: [{ where: { node: { id: id('h1-sec2') } } }] },
            },
          ],
        });
      expect(await linked(id('h1-tag3'), 'IT_TAGS', id('h1-sec2'))).toBe(false);
    });
  });

  // --- v2.4.8: blanket disconnect honours the target read policy ---------
  // `disconnect: [{}]` bound an anonymous target and severed links to
  // policy-HIDDEN charts too, while a `where`-scoped disconnect of the same
  // chart was (correctly) blocked.

  describe('blanket disconnect — target read policy', () => {
    async function seedTag(tag: string): Promise<void> {
      await run(
        `CREATE (t:ItTag {id: $t, runId: $runId})
         CREATE (pub:ItResource:ItChart {id: $pub, runId: $runId, secret: false, ownerId: 'u1', tenantId: 't1'})
         CREATE (sec:ItResource:ItChart {id: $sec, runId: $runId, secret: true, ownerId: 'u1', tenantId: 't1'})
         CREATE (t)-[:IT_TAGS]->(pub), (t)-[:IT_TAGS]->(sec)`,
        { t: id(`${tag}-tag`), pub: id(`${tag}-pub`), sec: id(`${tag}-sec`) },
      );
    }

    it('top-level `disconnect: [{}]` unlinks only visible charts', async () => {
      await seedTag('bd-top');
      await bound()
        .model('ItTag')
        .update({
          where: { id: id('bd-top-tag') },
          disconnect: { charts: [{}] },
        });
      expect(await linked(id('bd-top-tag'), 'IT_TAGS', id('bd-top-pub'))).toBe(
        false,
      );
      expect(await linked(id('bd-top-tag'), 'IT_TAGS', id('bd-top-sec'))).toBe(
        true,
      );
    });

    it('nested `update: { charts: [{ disconnect: [{}] }] }` unlinks only visible charts', async () => {
      await seedTag('bd-nested');
      await bound()
        .model('ItTag')
        .update({
          where: { id: id('bd-nested-tag') },
          update: { charts: [{ disconnect: [{}] }] },
        });
      expect(
        await linked(id('bd-nested-tag'), 'IT_TAGS', id('bd-nested-pub')),
      ).toBe(false);
      expect(
        await linked(id('bd-nested-tag'), 'IT_TAGS', id('bd-nested-sec')),
      ).toBe(true);
    });

    it('without policies, a blanket disconnect still unlinks everything', async () => {
      await seedTag('bd-nopol');
      await new OGM({ typeDefs, driver }).model('ItTag').update({
        where: { id: id('bd-nopol-tag') },
        disconnect: { charts: [{}] },
      });
      expect(
        await linked(id('bd-nopol-tag'), 'IT_TAGS', id('bd-nopol-pub')),
      ).toBe(false);
      expect(
        await linked(id('bd-nopol-tag'), 'IT_TAGS', id('bd-nopol-sec')),
      ).toBe(false);
    });
  });

  // --- H4: cascade delete ---------------------------------------------------

  describe('H4 — cascade delete', () => {
    it('honors the per-relationship where (README example)', async () => {
      await run(
        `CREATE (c:ItResource:ItChart {id: $c, runId: $runId, ownerId: 'u1', secret: false, tenantId: 't1'})
         CREATE (other:ItResource:ItChart {id: $other, runId: $runId, ownerId: 'u1', secret: false, tenantId: 't1'})
         CREATE (temp:ItCategory {id: $temp, runId: $runId, name: 'Temp', protected: false})
         CREATE (fic:ItCategory {id: $fic, runId: $runId, name: 'Fiction', protected: false})
         CREATE (c)-[:IT_IN_CATEGORY]->(temp), (c)-[:IT_IN_CATEGORY]->(fic), (other)-[:IT_IN_CATEGORY]->(fic)`,
        {
          c: id('h4-c'),
          other: id('h4-other'),
          temp: id('h4-temp'),
          fic: id('h4-fic'),
        },
      );
      await bound()
        .model('ItChart')
        .delete({
          where: { id: id('h4-c') },
          delete: { categories: [{ where: { node: { name: 'Temp' } } }] },
        });
      expect(await exists(id('h4-c'))).toBe(false);
      expect(await exists(id('h4-temp'))).toBe(false);
      expect(await exists(id('h4-fic'))).toBe(true);
    });

    it("gates cascaded nodes by the target's delete policy", async () => {
      await run(
        `CREATE (c:ItResource:ItChart {id: $c, runId: $runId, ownerId: 'u1', secret: false, tenantId: 't1'})
         CREATE (p:ItCategory {id: $p, runId: $runId, name: 'Prot', protected: true})
         CREATE (u:ItCategory {id: $u, runId: $runId, name: 'Unprot', protected: false})
         CREATE (c)-[:IT_IN_CATEGORY]->(p), (c)-[:IT_IN_CATEGORY]->(u)`,
        { c: id('h4b-c'), p: id('h4b-prot'), u: id('h4b-unprot') },
      );
      await bound()
        .model('ItChart')
        .delete({ where: { id: id('h4b-c') }, delete: { categories: [{}] } });
      expect(await exists(id('h4b-unprot'))).toBe(false);
      expect(await exists(id('h4b-prot'))).toBe(true);
    });

    it('rejects multi-level cascade and deletes nothing', async () => {
      await run(
        `CREATE (c:ItResource:ItChart {id: $c, runId: $runId, ownerId: 'u1', secret: false, tenantId: 't1'})
         CREATE (k:ItCategory {id: $k, runId: $runId, name: 'K', protected: false})
         CREATE (c)-[:IT_IN_CATEGORY]->(k)`,
        { c: id('h4c-c'), k: id('h4c-k') },
      );
      await expect(
        bound()
          .model('ItChart')
          .delete({
            where: { id: id('h4c-c') },
            delete: { categories: [{ delete: { charts: [{}] } }] },
          }),
      ).rejects.toBeInstanceOf(OGMError);
      expect(await exists(id('h4c-c'))).toBe(true);
      expect(await exists(id('h4c-k'))).toBe(true);
    });
  });

  // --- Nested writes enforce the target type's policies --------------------

  describe('nested writes', () => {
    beforeEach(async () => {
      await run(
        `MATCH (n) WHERE n.runId = $runId AND n.id STARTS WITH $prefix DETACH DELETE n`,
        { prefix: id('nw-') },
      );
      await run(
        `CREATE (cat:ItCategory {id: $cat, runId: $runId, name: 'NW', protected: false})
         CREATE (mine:ItResource:ItChart {id: $mine, runId: $runId, ownerId: 'u1', secret: false, tenantId: 't1', title: 'orig'})
         CREATE (theirs:ItResource:ItChart {id: $theirs, runId: $runId, ownerId: 'u2', secret: false, tenantId: 't1', title: 'orig'})
         CREATE (mine)-[:IT_IN_CATEGORY]->(cat), (theirs)-[:IT_IN_CATEGORY]->(cat)`,
        { cat: id('nw-cat'), mine: id('nw-mine'), theirs: id('nw-theirs') },
      );
    });

    const title = async (chartId: string) =>
      (
        await run('MATCH (c {id: $chartId}) RETURN c.title AS t', { chartId })
      )[0]?.t;

    it("nested update is row-filtered by the target's update policy", async () => {
      await bound()
        .model('ItCategory')
        .update({
          where: { id: id('nw-cat') },
          update: {
            charts: [{ where: { node: {} }, update: { node: { title: 'x' } } }],
          },
        });
      expect(await title(id('nw-mine'))).toBe('x');
      expect(await title(id('nw-theirs'))).toBe('orig');
    });

    it("nested update applies the target's write restrictive", async () => {
      await expect(
        bound()
          .model('ItCategory')
          .update({
            where: { id: id('nw-cat') },
            update: {
              charts: [
                {
                  where: { node: { id: id('nw-mine') } },
                  update: { node: { tenantId: 'other' } },
                },
              ],
            },
          }),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      const rows = await run('MATCH (c {id: $c}) RETURN c.tenantId AS t', {
        c: id('nw-mine'),
      });
      expect(rows[0].t).toBe('t1');
    });

    it("nested create (in update) needs the target's create permissive", async () => {
      await expect(
        bound()
          .model('ItCategory')
          .update({
            where: { id: id('nw-cat') },
            update: {
              charts: [
                {
                  create: [
                    { node: { id: id('nw-new1'), runId, tenantId: 't1' } },
                  ],
                },
              ],
            },
          }),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      expect(await exists(id('nw-new1'))).toBe(false);
    });

    it("nested create (in create) applies the target's write restrictive", async () => {
      await expect(
        bound({ ...CTX, canCreateChart: true })
          .model('ItCategory')
          .create({
            input: [
              {
                id: id('nw-cat2'),
                runId,
                charts: {
                  create: [
                    { node: { id: id('nw-new2'), runId, tenantId: 'other' } },
                  ],
                },
              },
            ],
          }),
      ).rejects.toBeInstanceOf(PolicyDeniedError);
      expect(await exists(id('nw-new2'))).toBe(false);
      expect(await exists(id('nw-cat2'))).toBe(false);
    });

    it("delete inside update uses the target's delete policy", async () => {
      await bound()
        .model('ItCategory')
        .update({
          where: { id: id('nw-cat') },
          update: { charts: [{ delete: [{ where: { node: {} } }] }] },
        });
      expect(await exists(id('nw-mine'))).toBe(false);
      expect(await exists(id('nw-theirs'))).toBe(true);
    });
  });

  // --- Traversal inside a nested-write where -------------------------------

  it("traversal in a nested-write where enforces the traversed type's read policy", async () => {
    await run(
      `CREATE (pub:ItResource:ItChart {id: $pub, runId: $runId, ownerId: 'u1', secret: false, tenantId: 't1'})
       CREATE (sec:ItResource:ItChart {id: $sec, runId: $runId, ownerId: 'u1', secret: true, tenantId: 't1'})
       CREATE (t:ItTag {id: $t, runId: $runId})
       CREATE (t)-[:IT_TAGS]->(pub), (t)-[:IT_TAGS]->(sec)`,
      { pub: id('tw-pub'), sec: id('tw-sec'), t: id('tw-tag') },
    );
    // Disconnect tags that tag the (hidden) secret chart — the hidden chart
    // must not be usable as an existence oracle.
    await bound()
      .model('ItChart')
      .update({
        where: { id: id('tw-pub') },
        disconnect: {
          tags: [{ where: { node: { charts_SOME: { id: id('tw-sec') } } } }],
        },
      });
    expect(await linked(id('tw-tag'), 'IT_TAGS', id('tw-pub'))).toBe(true);
  });

  // --- Traversal composition + H5 abstract targets -------------------------

  describe('traversal composition and abstract targets', () => {
    const tag = () => id('tc-tag');
    const ids = (rows: unknown) =>
      ((rows ?? []) as { id: string }[]).map((r) => r.id).sort();

    beforeAll(async () => {
      await run(
        `CREATE (t:ItTag {id: $t, runId: $runId})
         CREATE (t2:ItTag {id: $t2, runId: $runId})
         CREATE (pub:ItResource:ItChart {id: $pub, runId: $runId, secret: false, ownerId: 'u1', tenantId: 't1', title: 'ok'})
         CREATE (sec:ItResource:ItChart {id: $sec, runId: $runId, secret: true, ownerId: 'u1', tenantId: 't1', title: 'bad'})
         CREATE (drug:ItResource:ItDrug {id: $drug, runId: $runId, tenantId: 't1'})
         CREATE (okDoc:ItDoc {id: $okDoc, runId: $runId, approvedAt: '2026-01-01'})
         CREATE (badDoc:ItDoc {id: $badDoc, runId: $runId})
         CREATE (t)-[:IT_TAGS {weight: 1}]->(pub), (t)-[:IT_TAGS {weight: 9}]->(sec)
         CREATE (t)-[:IT_TAGS_RES]->(pub), (t)-[:IT_TAGS_RES]->(sec), (t)-[:IT_TAGS_RES]->(drug)
         CREATE (t)-[:IT_TAGS_ITEM]->(pub), (t)-[:IT_TAGS_ITEM]->(sec),
                (t)-[:IT_TAGS_ITEM]->(okDoc), (t)-[:IT_TAGS_ITEM]->(badDoc)`,
        {
          t: tag(),
          t2: id('tc-tag2'),
          pub: id('tc-pub'),
          sec: id('tc-sec'),
          drug: id('tc-drug'),
          okDoc: id('tc-okdoc'),
          badDoc: id('tc-baddoc'),
        },
      );
    });

    const findTag = (where: Record<string, unknown>) =>
      bound()
        .model('ItTag')
        .find({ where: { id: tag(), ...where } });

    it('_ALL is not falsified by a hidden related node', async () => {
      expect(await findTag({ charts_ALL: { title: 'ok' } })).toHaveLength(1);
    });

    it('connection node_NOT is not satisfied by a hidden node', async () => {
      expect(
        await findTag({ chartsConnection: { node_NOT: { id: id('tc-pub') } } }),
      ).toEqual([]);
    });

    it('an edge-only connection filter cannot match a hidden node', async () => {
      expect(
        await findTag({ chartsConnection: { edge: { weight: 9 } } }),
      ).toEqual([]);
    });

    it('enforcement cascades through a policy-free middle type', async () => {
      expect(
        await findTag({
          charts_SOME: { tags_SOME: { charts_SOME: { id: id('tc-sec') } } },
        }),
      ).toEqual([]);
    });

    it('interface-target traversal applies each member policy', async () => {
      expect(await findTag({ resources_SOME: { id: id('tc-sec') } })).toEqual(
        [],
      );
      expect(await findTag({ resources_SOME: { id: id('tc-drug') } })).toEqual(
        [],
      );
      expect(
        await findTag({ resources_SOME: { id: id('tc-pub') } }),
      ).toHaveLength(1);
    });

    it('interface-target nested selection shows only visible members', async () => {
      const [row] = await bound()
        .model('ItTag')
        .find({
          where: { id: tag() },
          selectionSet: '{ id resources { id } }',
        });
      expect(ids(row.resources)).toEqual([id('tc-pub')]);
    });

    it('union-target nested selection shows only visible members', async () => {
      const [row] = await bound()
        .model('ItTag')
        .find({
          where: { id: tag() },
          selectionSet:
            '{ id items { ... on ItChart { id } ... on ItDoc { id } } }',
        });
      expect(ids(row.items)).toEqual([id('tc-okdoc'), id('tc-pub')].sort());
    });

    it('interface-target connect cannot link a hidden member', async () => {
      await bound()
        .model('ItTag')
        .update({
          where: { id: id('tc-tag2') },
          connect: {
            resources: [{ where: { node: { id: id('tc-sec') } } }],
          },
        });
      expect(await linked(id('tc-tag2'), 'IT_TAGS_RES', id('tc-sec'))).toBe(
        false,
      );
    });
  });

  // --- v2.5.2: nested link through a read-only intermediate -----------------
  // A connect nested in a connect item (and a disconnect nested in a
  // disconnect item) writes the INTERMEDIATE chart's own relationships.
  // Pre-2.5.2 the chart was gated by `read` only, so a context that could
  // merely see it linked / unlinked its categories — which the direct
  // `ItChart.update({ connect | disconnect })` correctly refuses.

  describe('nested connect/disconnect through a read-only intermediate links/unlinks nothing', () => {
    const p = (s: string) => id(`rl-${s}`);
    // `theirs` is readable but owned by u2 (CTX is u1): read yes, update no.
    beforeEach(async () => {
      await run(
        `MATCH (n) WHERE n.runId = $runId AND n.id STARTS WITH $prefix DETACH DELETE n`,
        { prefix: p('') },
      );
      await run(
        `CREATE (:ItTag {id: $tag, runId: $runId})
         CREATE (theirs:ItResource:ItChart {id: $theirs, runId: $runId, ownerId: 'u2', secret: false, tenantId: 't1'})
         CREATE (mine:ItResource:ItChart {id: $mine, runId: $runId, ownerId: 'u1', secret: false, tenantId: 't1'})
         CREATE (:ItCategory {id: $k, runId: $runId, name: 'K', protected: false})
         CREATE (linked:ItCategory {id: $kl, runId: $runId, name: 'KL', protected: false})
         CREATE (theirs)-[:IT_IN_CATEGORY]->(linked), (mine)-[:IT_IN_CATEGORY]->(linked)`,
        {
          tag: p('tag'),
          theirs: p('theirs'),
          mine: p('mine'),
          k: p('k'),
          kl: p('kl'),
        },
      );
    });

    const charts = (chartId: string, nested: Record<string, unknown>) => [
      { where: { node: { id: chartId } }, ...nested },
    ];
    const connectK = {
      connect: { categories: [{ where: { node: { id: p('k') } } }] },
    };
    const disconnectKL = {
      disconnect: { categories: [{ where: { node: { id: p('kl') } } }] },
    };

    it('the direct update of the read-only chart links nothing (baseline)', async () => {
      await bound()
        .model('ItChart')
        .update({
          where: { id: p('theirs') },
          connect: { categories: [{ where: { node: { id: p('k') } } }] },
        });
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('k'))).toBe(false);
    });

    it('update: connect nested in a connect item', async () => {
      await bound()
        .model('ItTag')
        .update({
          where: { id: p('tag') },
          connect: { charts: charts(p('theirs'), connectK) },
        });
      // The outer link only needs read …
      expect(await linked(p('tag'), 'IT_TAGS', p('theirs'))).toBe(true);
      // … the chart's own relationship needs update.
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('k'))).toBe(false);
    });

    it('the owner (who has update) CAN do the nested connect', async () => {
      await bound()
        .model('ItTag')
        .update({
          where: { id: p('tag') },
          connect: { charts: charts(p('mine'), connectK) },
        });
      expect(await linked(p('tag'), 'IT_TAGS', p('mine'))).toBe(true);
      expect(await linked(p('mine'), 'IT_IN_CATEGORY', p('k'))).toBe(true);
    });

    it('create: connect nested in a connect item', async () => {
      await bound()
        .model('ItTag')
        .create({
          input: [
            {
              id: p('tag2'),
              runId,
              charts: { connect: charts(p('theirs'), connectK) },
            },
          ],
        });
      expect(await linked(p('tag2'), 'IT_TAGS', p('theirs'))).toBe(true);
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('k'))).toBe(false);
    });

    it('update body: item connect with a nested connect', async () => {
      await bound()
        .model('ItTag')
        .update({
          where: { id: p('tag') },
          update: { charts: [{ connect: charts(p('theirs'), connectK) }] },
        });
      expect(await linked(p('tag'), 'IT_TAGS', p('theirs'))).toBe(true);
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('k'))).toBe(false);
    });

    it('per-member abstract connect with a nested connect', async () => {
      await bound()
        .model('ItTag')
        .update({
          where: { id: p('tag') },
          connect: { items: { ItChart: charts(p('theirs'), connectK) } },
        });
      expect(await linked(p('tag'), 'IT_TAGS_ITEM', p('theirs'))).toBe(true);
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('k'))).toBe(false);
    });

    it('updateMany: item connect with a nested connect', async () => {
      await bound()
        .model('ItTag')
        .updateMany({
          where: { id: p('tag') },
          data: { charts: [{ connect: charts(p('theirs'), connectK) }] },
        });
      expect(await linked(p('tag'), 'IT_TAGS', p('theirs'))).toBe(true);
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('k'))).toBe(false);
    });

    it('depth 3: the read-only chart deeper in the chain is gated too', async () => {
      // tag → mine (update ok) → kl (update ok) → theirs (read only) → k
      await bound()
        .model('ItTag')
        .update({
          where: { id: p('tag') },
          connect: {
            charts: charts(p('mine'), {
              connect: {
                categories: [
                  {
                    where: { node: { id: p('kl') } },
                    connect: {
                      charts: [
                        {
                          where: { node: { id: p('theirs') } },
                          ...connectK,
                        },
                      ],
                    },
                  },
                ],
              },
            }),
          },
        });
      expect(await linked(p('tag'), 'IT_TAGS', p('mine'))).toBe(true);
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('kl'))).toBe(true);
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('k'))).toBe(false);
    });

    it('update: disconnect nested in a disconnect item', async () => {
      await run(
        `MATCH (t:ItTag {id: $t}), (c:ItChart) WHERE c.id IN [$theirs, $mine]
         CREATE (t)-[:IT_TAGS]->(c)`,
        { t: p('tag'), theirs: p('theirs'), mine: p('mine') },
      );
      await bound()
        .model('ItTag')
        .update({
          where: { id: p('tag') },
          disconnect: { charts: charts(p('theirs'), disconnectKL) },
        });
      expect(await linked(p('tag'), 'IT_TAGS', p('theirs'))).toBe(false);
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('kl'))).toBe(true);

      // The owner can.
      await bound()
        .model('ItTag')
        .update({
          where: { id: p('tag') },
          disconnect: { charts: charts(p('mine'), disconnectKL) },
        });
      expect(await linked(p('mine'), 'IT_IN_CATEGORY', p('kl'))).toBe(false);
    });

    it('update: blanket nested disconnect', async () => {
      await run(
        `MATCH (t:ItTag {id: $t}), (c:ItChart {id: $theirs}) CREATE (t)-[:IT_TAGS]->(c)`,
        { t: p('tag'), theirs: p('theirs') },
      );
      await bound()
        .model('ItTag')
        .update({
          where: { id: p('tag') },
          disconnect: {
            charts: charts(p('theirs'), { disconnect: { categories: null } }),
          },
        });
      expect(await linked(p('tag'), 'IT_TAGS', p('theirs'))).toBe(false);
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('kl'))).toBe(true);
    });

    it('update body: item disconnect with a nested disconnect', async () => {
      await run(
        `MATCH (t:ItTag {id: $t}), (c:ItChart {id: $theirs}) CREATE (t)-[:IT_TAGS]->(c)`,
        { t: p('tag'), theirs: p('theirs') },
      );
      await bound()
        .model('ItTag')
        .update({
          where: { id: p('tag') },
          update: {
            charts: [{ disconnect: charts(p('theirs'), disconnectKL) }],
          },
        });
      expect(await linked(p('tag'), 'IT_TAGS', p('theirs'))).toBe(false);
      expect(await linked(p('theirs'), 'IT_IN_CATEGORY', p('kl'))).toBe(true);
    });
  });

  // --- H3: null semantics ---------------------------------------------------

  it('H3 — approvedAt_NOT: null in a restrictive hides unapproved docs', async () => {
    await run(
      `CREATE (:ItDoc {id: $a, runId: $runId, approvedAt: '2026-01-01'})
       CREATE (:ItDoc {id: $u, runId: $runId})`,
      { a: id('h3-approved'), u: id('h3-unapproved') },
    );
    const docs = await bound()
      .model('ItDoc')
      .find({ where: { id_IN: [id('h3-approved'), id('h3-unapproved')] } });
    expect(docs.map((d) => d.id)).toEqual([id('h3-approved')]);
  });

  // --- H2: interface branches ------------------------------------------------

  it('H2 — interface reads deny an implementer whose permissives are gated off', async () => {
    await run(
      `CREATE (:ItResource:ItDrug {id: $d, runId: $runId, tenantId: 't1'})`,
      {
        d: id('h2-drug'),
      },
    );
    const direct = await bound()
      .model('ItDrug')
      .find({ where: { id: id('h2-drug') } });
    expect(direct).toEqual([]);
    const viaInterface = await bound()
      .interfaceModel('ItResource')
      .find({ where: { id: id('h2-drug') } });
    expect(viaInterface).toEqual([]);
  });

  // --- v2.5.4: a node carrying two implementer labels -----------------------
  // Pre-2.5.4 the per-member policy was a first-match CASE: a node labelled
  // with two implementers was admitted under the first (laxer) member and
  // the second member's policy was never evaluated.

  describe('v2.5.4 — multi-label nodes pass every carried member policy', () => {
    const m = (suffix: string) => id(`ml-${suffix}`);
    const ids = (rows: unknown) =>
      ((rows ?? []) as { id: string }[]).map((r) => r.id).sort();

    beforeAll(async () => {
      await run(
        `CREATE (:ItResource:ItChart:ItDrug {id: $ab, runId: $runId, secret: false, tenantId: 't1'})
         CREATE (:ItResource:ItChart {id: $chart, runId: $runId, secret: false, tenantId: 't1'})
         CREATE (h:ItFragHolder {id: $h, runId: $runId})
         CREATE (a:ItFragA {id: $a, runId: $runId, title: 'hey'})
         CREATE (b:ItFragB {id: $b, runId: $runId, secret: false})
         CREATE (bs:ItFragB {id: $bs, runId: $runId, secret: true})
         CREATE (hidden:ItFragA:ItFragB {id: $hidden, runId: $runId, title: 'both', secret: true})
         CREATE (both:ItFragA:ItFragB {id: $both, runId: $runId, title: 'ok', secret: false})
         CREATE (h)-[:IT_HOLDS]->(a), (h)-[:IT_HOLDS]->(b), (h)-[:IT_HOLDS]->(bs),
                (h)-[:IT_HOLDS]->(hidden), (h)-[:IT_HOLDS]->(both)
         CREATE (:ItTag {id: $t, runId: $runId})
         CREATE (tl:ItTag {id: $tl, runId: $runId})
         CREATE (tl)-[:IT_TAGS_RES]->(:ItResource:ItChart:ItDrug {id: $ab0, runId: $runId, secret: false, tenantId: 't1'})`,
        {
          ab: m('ab'),
          chart: m('chart'),
          h: m('holder'),
          a: m('a'),
          b: m('b'),
          bs: m('bs'),
          hidden: m('hidden'),
          both: m('both'),
          t: m('tag'),
          tl: m('tag-linked'),
          ab0: m('ab0'),
        },
      );
    });

    it('InterfaceModel does not return a node the stricter member hides', async () => {
      // `ItDrug` read is default-denied; `ItChart` admits `secret: false`.
      expect(
        await bound()
          .model('ItDrug')
          .find({ where: { id: m('ab') } }),
      ).toEqual([]);
      expect(
        await bound()
          .interfaceModel('ItResource')
          .find({ where: { id: m('ab') }, labels: ['ItDrug'] }),
      ).toEqual([]);
      expect(
        await bound()
          .interfaceModel('ItResource')
          .find({ where: { id: m('ab') } }),
      ).toEqual([]);
      expect(
        await bound()
          .interfaceModel('ItResource')
          .count({ where: { id: m('ab') } }),
      ).toBe(0);
    });

    it('single-label nodes are unchanged', async () => {
      const rows = await bound()
        .interfaceModel('ItResource')
        .find({ where: { id_IN: [m('ab'), m('chart')] } });
      expect(rows.map((r) => [r.id, r.__typename])).toEqual([
        [m('chart'), 'ItChart'],
      ]);
    });

    it('fragment @cypher through a relationship: no hidden member fields', async () => {
      const [holder] = await bound()
        .model('ItFragHolder')
        .find({
          where: { id: m('holder') },
          selectionSet:
            '{ id res { id ... on ItFragA { shout } ... on ItFragB { whisper secret } } }',
        });
      const res = holder.res as Record<string, unknown>[];
      expect(ids(res)).toEqual([m('a'), m('b'), m('both')].sort());
      expect(res.some((r) => r.whisper === `b-${m('hidden')}`)).toBe(false);
      expect(res.some((r) => r.secret === true)).toBe(false);
      // A node both members admit is returned with both members' fields.
      expect(res.find((r) => r.id === m('both'))).toMatchObject({
        shout: 'ok!',
        whisper: `b-${m('both')}`,
        secret: false,
      });
      expect(res.find((r) => r.id === m('a'))).toMatchObject({
        __typename: 'ItFragA',
        shout: 'hey!',
        whisper: null,
      });
      expect(res.find((r) => r.id === m('b'))).toMatchObject({
        __typename: 'ItFragB',
        whisper: `b-${m('b')}`,
      });
    });

    it('fragment @cypher at the InterfaceModel root: no hidden member fields', async () => {
      const rows = await bound()
        .interfaceModel('ItFrag')
        .find({
          where: { id_IN: [m('a'), m('b'), m('bs'), m('hidden'), m('both')] },
          selectionSet:
            '{ id ... on ItFragA { shout } ... on ItFragB { whisper } }',
        });
      expect(ids(rows)).toEqual([m('a'), m('b'), m('both')].sort());
      expect(rows.find((r) => r.id === m('both'))).toMatchObject({
        shout: 'ok!',
        whisper: `b-${m('both')}`,
      });
    });

    it('without a policy context every node is still returned', async () => {
      const rows = await ogm.interfaceModel('ItFrag').find({
        where: { id_IN: [m('hidden'), m('both')] },
      });
      expect(ids(rows)).toEqual([m('both'), m('hidden')].sort());
    });

    it('interface-target traversal cannot match the multi-label node', async () => {
      expect(
        await bound()
          .model('ItTag')
          .find({
            where: { id: m('tag-linked'), resources_SOME: { id: m('ab0') } },
          }),
      ).toEqual([]);
    });

    it('interface-target connect cannot link the multi-label node', async () => {
      await bound()
        .model('ItTag')
        .update({
          where: { id: m('tag') },
          connect: { resources: [{ where: { node: { id: m('ab') } } }] },
        });
      expect(await linked(m('tag'), 'IT_TAGS_RES', m('ab'))).toBe(false);
    });

    it('interface-target connect still links a single-label visible node', async () => {
      await bound()
        .model('ItTag')
        .update({
          where: { id: m('tag') },
          connect: { resources: [{ where: { node: { id: m('chart') } } }] },
        });
      expect(await linked(m('tag'), 'IT_TAGS_RES', m('chart'))).toBe(true);
    });

    it('interface-target disconnect cannot unlink the multi-label node', async () => {
      await bound()
        .model('ItTag')
        .update({
          where: { id: m('tag-linked') },
          disconnect: { resources: [{ where: { node: { id: m('ab0') } } }] },
        });
      expect(await linked(m('tag-linked'), 'IT_TAGS_RES', m('ab0'))).toBe(true);
    });
  });
});
