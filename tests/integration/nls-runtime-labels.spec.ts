/**
 * Live suite — runtime labels under Node-Level Security (v2.10.1).
 *
 * Opt-in: runs only when NEO4J_URI is set. Every node carries this run's
 * `runId`, all labels start with `ItLbl`, and `afterAll` deletes by runId.
 *
 * Pre-2.10.1 the runtime `labels` of `create` / `createMany` / `upsert`
 * and the `addLabels` / `removeLabels` of `setLabels` were only validated
 * as identifiers, and only the ROOT model's policies ran. A label naming
 * a protected type therefore minted or converted nodes of that type with
 * none of its policies (an attacker-forged, victim-owned `Secret`), and a
 * context that could update but not read a `Secret` relabelled it into an
 * unprotected type and read it there. Each scenario asserts a DATABASE
 * outcome; they fail on v2.10.0 and pass with the fix.
 */
import { randomUUID } from 'node:crypto';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import { permissive, restrictive } from '../../src/policy/types';

const URI = process.env.NEO4J_URI;
const describeLive = URI ? describe : describe.skip;

jest.setTimeout(60_000);

const typeDefs = `
type ItLblPublic @node {
  id: ID! @id @unique
  runId: String!
  title: String
  ownerId: String
  tenantId: String
}
type ItLblSecret @node {
  id: ID! @id @unique
  runId: String!
  title: String
  ownerId: String
  tenantId: String
  classification: String
}
`;

type Ctx = { uid: string; role: string; tenant: string };
const attacker: Ctx = { uid: 'u-att', role: 'user', tenant: 't1' };
const victim: Ctx = { uid: 'u-vic', role: 'user', tenant: 't1' };
const admin: Ctx = { uid: 'u-adm', role: 'admin', tenant: 't1' };

/** Secret: owners read their rows; only admins create / update / delete. */
const adminWrites = {
  ItLblSecret: [
    permissive({
      operations: ['read'],
      when: (c) => ({ ownerId: (c as Ctx).uid }),
      name: 'secret.read-own',
    }),
    permissive({
      operations: ['create', 'update', 'delete'],
      appliesWhen: (c) => (c as Ctx).role === 'admin',
      when: () => ({}),
      name: 'secret.admin-writes',
    }),
    restrictive({
      operations: ['create', 'update'],
      when: (c) => (c as Ctx).role === 'admin',
      name: 'secret.with-check-admin',
    }),
  ],
};

/** Secret: owners read their rows; anyone updates their tenant's rows. */
const tenantUpdate = {
  ItLblSecret: [
    permissive({
      operations: ['read'],
      when: (c) => ({ ownerId: (c as Ctx).uid }),
      name: 'secret.read-own',
    }),
    permissive({
      operations: ['update'],
      when: (c) => ({ tenantId: (c as Ctx).tenant }),
      name: 'secret.update-tenant',
    }),
  ],
};

describeLive('NLS — runtime labels (v2.10.1) — live Neo4j', () => {
  const runId = `it-${randomUUID()}`;
  const id = (suffix: string) => `${runId}-${suffix}`;
  let driver: Driver;
  /** `adminWrites` policies. */
  let ogm: OGM;
  /** `tenantUpdate` policies. */
  let ogm2: OGM;

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

  async function labelsOf(nodeId: string): Promise<string[]> {
    const rows = await run('MATCH (n {id: $nodeId}) RETURN labels(n) AS l', {
      nodeId,
    });
    return ((rows[0]?.l as string[]) ?? []).sort();
  }

  async function countTitled(title: string): Promise<number> {
    const rows = await run(
      'MATCH (n {runId: $runId, title: $title}) RETURN count(n) AS c',
      { title },
    );
    return Number(rows[0].c);
  }

  async function denied(
    fn: () => Promise<unknown>,
  ): Promise<PolicyDeniedError> {
    try {
      await fn();
    } catch (e) {
      if (e instanceof PolicyDeniedError) return e;
      throw e;
    }
    throw new Error('expected PolicyDeniedError');
  }

  const firstCreated = (res: unknown): { id: string } =>
    (
      Object.values(res as Record<string, unknown>).find(Array.isArray) as {
        id: string;
      }[]
    )[0];

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
    ogm = new OGM({ typeDefs, driver, policies: adminWrites });
    ogm2 = new OGM({ typeDefs, driver, policies: tenantUpdate });
  });

  afterAll(async () => {
    if (driver) {
      await run('MATCH (n) WHERE n.runId = $runId DETACH DELETE n');
      await driver.close();
    }
  });

  it('control: the attacker cannot create a Secret directly', async () => {
    const e = await denied(() =>
      ogm
        .withContext(attacker)
        .model('ItLblSecret')
        .create({ input: [{ runId, title: 'direct', ownerId: victim.uid }] }),
    );
    expect(e.operation).toBe('create');
    expect(await countTitled('direct')).toBe(0);
  });

  describe('create / createMany / upsert with labels naming a protected type', () => {
    it('S5p-2b — Public.create with labels: [Secret] is denied, and nothing is written', async () => {
      const e = await denied(() =>
        ogm
          .withContext(attacker)
          .model('ItLblPublic')
          .create({
            input: [{ runId, title: 'forged-create', ownerId: victim.uid }],
            labels: ['ItLblSecret'],
          }),
      );
      expect(e.typeName).toBe('ItLblSecret');
      expect(e.operation).toBe('create');
      expect(await countTitled('forged-create')).toBe(0);
      expect(
        await ogm
          .withContext(victim)
          .model('ItLblSecret')
          .find({ where: { title: 'forged-create' } }),
      ).toEqual([]);
    });

    it('S5p-2c — Public.createMany with labels: [Secret] is denied, and nothing is written', async () => {
      await denied(() =>
        ogm
          .withContext(attacker)
          .model('ItLblPublic')
          .createMany({
            data: [
              { id: id('cm1'), runId, title: 'forged-cm', ownerId: victim.uid },
              { id: id('cm2'), runId, title: 'forged-cm', ownerId: victim.uid },
            ],
            labels: ['ItLblSecret'],
          }),
      );
      expect(await countTitled('forged-cm')).toBe(0);
    });

    it('Public.upsert with labels: [Secret] is denied, and nothing is written', async () => {
      await denied(() =>
        ogm
          .withContext(attacker)
          .model('ItLblPublic')
          .upsert({
            where: { id: id('up1') },
            create: { runId, title: 'forged-upsert', ownerId: victim.uid },
            update: { title: 'forged-upsert' },
            labels: ['ItLblSecret'],
          }),
      );
      expect(await labelsOf(id('up1'))).toEqual([]);
    });

    it("a context the named type's create policy admits mints the node as both types", async () => {
      const res = await ogm
        .withContext(admin)
        .model('ItLblPublic')
        .create({
          input: [{ runId, title: 'admin-minted', ownerId: victim.uid }],
          labels: ['ItLblSecret'],
        });
      const created = firstCreated(res);
      expect(await labelsOf(created.id)).toEqual([
        'ItLblPublic',
        'ItLblSecret',
      ]);
      const seen = await ogm
        .withContext(victim)
        .model('ItLblSecret')
        .find({ where: { id: created.id } });
      expect(seen).toHaveLength(1);

      const { count } = await ogm
        .withContext(admin)
        .model('ItLblPublic')
        .createMany({
          data: [
            { id: id('acm1'), runId, title: 'admin-cm', ownerId: victim.uid },
            { id: id('acm2'), runId, title: 'admin-cm', ownerId: victim.uid },
          ],
          labels: ['ItLblSecret'],
        });
      expect(count).toBe(2);
      expect(await labelsOf(id('acm2'))).toEqual([
        'ItLblPublic',
        'ItLblSecret',
      ]);
    });

    it('a label no declared type carries is still allowed', async () => {
      const res = await ogm
        .withContext(attacker)
        .model('ItLblPublic')
        .create({
          input: [{ runId, title: 'tagged', ownerId: attacker.uid }],
          labels: ['ItLblArchived'],
        });
      expect(await labelsOf(firstCreated(res).id)).toEqual([
        'ItLblArchived',
        'ItLblPublic',
      ]);
    });

    it('a per-call bypass skips the check', async () => {
      const res = await ogm
        .withContext(attacker)
        .model('ItLblPublic')
        .create({
          input: [{ runId, title: 'bypassed', ownerId: attacker.uid }],
          labels: ['ItLblSecret'],
          unsafe: { bypassPolicies: true },
        });
      expect(await labelsOf(firstCreated(res).id)).toEqual([
        'ItLblPublic',
        'ItLblSecret',
      ]);
    });
  });

  describe('setLabels', () => {
    beforeAll(async () => {
      await run(
        `CREATE (:ItLblPublic {id: $p1, runId: $runId, title: 'mine', ownerId: 'u-att', tenantId: 't1'})
         CREATE (:ItLblPublic {id: $p2, runId: $runId, title: 'mine-too', ownerId: 'u-att', tenantId: 't1'})
         CREATE (:ItLblPublic:ItLblSecret {id: $ps, runId: $runId, title: 'both', ownerId: 'u-vic', tenantId: 't1'})
         CREATE (:ItLblSecret {id: $s1, runId: $runId, title: 'victim-secret', ownerId: 'u-vic', tenantId: 't1', classification: 'TOP'})
         CREATE (:ItLblSecret {id: $s2, runId: $runId, title: 'victim-secret-2', ownerId: 'u-vic', tenantId: 't1', classification: 'TOP'})
         CREATE (:ItLblSecret {id: $s3, runId: $runId, title: 'victim-secret-3', ownerId: 'u-vic', tenantId: 't1', classification: 'TOP'})`,
        {
          p1: id('p1'),
          p2: id('p2'),
          ps: id('ps'),
          s1: id('s1'),
          s2: id('s2'),
          s3: id('s3'),
        },
      );
    });

    it('S5p-2d — addLabels: [Secret] on an own Public row is denied before anything runs', async () => {
      const e = await denied(() =>
        ogm
          .withContext(attacker)
          .model('ItLblPublic')
          .setLabels({ where: { id: id('p1') }, addLabels: ['ItLblSecret'] }),
      );
      expect(e.typeName).toBe('ItLblSecret');
      expect(e.operation).toBe('create');
      expect(await labelsOf(id('p1'))).toEqual(['ItLblPublic']);
    });

    it('addLabels naming a type the context may create relabels the row', async () => {
      await ogm
        .withContext(admin)
        .model('ItLblPublic')
        .setLabels({ where: { id: id('p2') }, addLabels: ['ItLblSecret'] });
      expect(await labelsOf(id('p2'))).toEqual(['ItLblPublic', 'ItLblSecret']);
    });

    it('S5p-2e — an update-but-not-read context cannot relabel a Secret into Public and read it there', async () => {
      const A = ogm2.withContext(attacker);
      expect(
        await A.model('ItLblSecret').find({ where: { id: id('s1') } }),
      ).toEqual([]);
      await A.model('ItLblSecret').setLabels({
        where: { id: id('s1') },
        addLabels: ['ItLblPublic'],
      });
      expect(await labelsOf(id('s1'))).toEqual(['ItLblSecret']);
      expect(
        await A.model('ItLblPublic').find({ where: { id: id('s1') } }),
      ).toEqual([]);
    });

    it('the owner (read + update) may relabel its own Secret', async () => {
      await ogm2
        .withContext(victim)
        .model('ItLblSecret')
        .setLabels({ where: { id: id('s1') }, addLabels: ['ItLblPublic'] });
      expect(await labelsOf(id('s1'))).toEqual(['ItLblPublic', 'ItLblSecret']);
    });

    it('a default-mode upsert cannot relabel a matched Secret the context cannot read (left untouched, null returned)', async () => {
      const result = await ogm2
        .withContext(attacker)
        .model('ItLblSecret')
        .upsert({
          where: { id: id('s2') },
          create: {
            runId,
            title: 'new',
            ownerId: attacker.uid,
            tenantId: 't1',
          },
          update: { title: 'rewritten' },
          labels: ['ItLblPublic'],
        });
      expect(result).toBeNull();
      expect(await labelsOf(id('s2'))).toEqual(['ItLblSecret']);
      const rows = await run('MATCH (n {id: $nodeId}) RETURN n.title AS t', {
        nodeId: id('s2'),
      });
      expect(rows[0].t).toBe('victim-secret-2');
    });

    it('a default-mode createMany({ skipDuplicates }) cannot relabel a matched Secret the context cannot read', async () => {
      const { count } = await ogm2
        .withContext(attacker)
        .model('ItLblSecret')
        .createMany({
          data: [{ id: id('s3'), runId, title: 'dup', ownerId: attacker.uid }],
          skipDuplicates: true,
          labels: ['ItLblPublic'],
        });
      expect(count).toBe(0);
      expect(await labelsOf(id('s3'))).toEqual(['ItLblSecret']);
    });

    it("removeLabels naming a protected type requires that type's delete policy", async () => {
      await ogm
        .withContext(attacker)
        .model('ItLblPublic')
        .setLabels({ where: { id: id('ps') }, removeLabels: ['ItLblSecret'] });
      expect(await labelsOf(id('ps'))).toEqual(['ItLblPublic', 'ItLblSecret']);

      await ogm
        .withContext(admin)
        .model('ItLblPublic')
        .setLabels({ where: { id: id('ps') }, removeLabels: ['ItLblSecret'] });
      expect(await labelsOf(id('ps'))).toEqual(['ItLblPublic']);
    });
  });
});
