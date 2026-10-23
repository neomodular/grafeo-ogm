/**
 * v2.10.1 — runtime labels that name another declared node type
 * (`src/policy/labels.ts`).
 *
 * Pre-2.10.1 `create` / `createMany` / `upsert` `labels` and `setLabels`
 * `addLabels` / `removeLabels` were only validated as identifiers and only
 * the ROOT model's policies ran, so a label naming a protected type minted
 * or converted nodes of that type with none of its policies, and a node
 * the context could update but not read could be relabelled into an
 * unprotected type and read there. These tests pin the rule:
 *
 * - adding a declared type's label is a `create` on that type (default
 *   deny + WITH CHECK; `setLabels` checks WITH CHECK on an empty input);
 * - relabelling an existing node into a declared type also requires the
 *   root type's `read` row filter;
 * - removing a declared type's label is a `delete` on that type;
 * - undeclared labels, policy-free OGMs and bypasses are unchanged.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import { permissive, restrictive } from '../../src/policy/types';

const schema = `
interface Res {
  id: ID!
  tenantId: String
}
type Pub @node {
  id: ID! @id @unique
  title: String
  ownerId: String
  tenantId: String
}
type Secret @node {
  id: ID! @id @unique
  title: String
  ownerId: String
  tenantId: String
}
type Multi implements Res @node(labels: ["Res", "Multi"]) {
  id: ID! @id @unique
  tenantId: String
}
`;

type Ctx = { uid: string; role: string; tenant: string };
const user: Ctx = { uid: 'u1', role: 'user', tenant: 't1' };
const admin: Ctx = { uid: 'adm', role: 'admin', tenant: 't1' };
/** No `read` permissive applies to this context. */
const blind: Ctx = { uid: 'b1', role: 'blind', tenant: 't1' };

/**
 * Secret: read own rows (except `blind`); admins write anything, users may
 * update their tenant's rows; create WITH CHECK is ctx-only. `Res` (an
 * interface `Multi` implements): admin-only create.
 */
const policies = {
  Secret: [
    permissive({
      operations: ['read'],
      appliesWhen: (c) => (c as Ctx).role !== 'blind',
      when: (c) => ({ ownerId: (c as Ctx).uid }),
      name: 'secret.read-own',
    }),
    permissive({
      operations: ['create', 'update', 'delete'],
      appliesWhen: (c) => (c as Ctx).role === 'admin',
      when: () => ({}),
      name: 'secret.admin-writes',
    }),
    permissive({
      operations: ['update'],
      when: (c) => ({ tenantId: (c as Ctx).tenant }),
      name: 'secret.update-tenant',
    }),
    restrictive({
      operations: ['create'],
      when: (c) => (c as Ctx).role === 'admin',
      name: 'secret.create-admin-check',
    }),
  ],
  Res: [
    permissive({
      operations: ['create'],
      appliesWhen: (c) => (c as Ctx).role === 'admin',
      when: () => ({}),
      name: 'res.create-admin',
    }),
  ],
};

/** Secret: anyone may create, but WITH CHECK inspects the input's tenant. */
const tenantCheck = {
  Secret: [
    permissive({
      operations: ['create'],
      when: () => ({}),
      name: 'secret.create-any',
    }),
    restrictive({
      operations: ['create'],
      when: (c, input) => input.tenantId === (c as Ctx).tenant,
      name: 'secret.create-tenant',
    }),
  ],
};

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
  config: { metadata?: Record<string, unknown> } | undefined;
}

function createMockDriver(records: Recorded[] = []): Driver {
  const session = {
    run: jest.fn(
      (cypher: string, params: Record<string, unknown>, config?: unknown) => {
        records.push({
          cypher,
          params,
          config: config as Recorded['config'],
        });
        return Promise.resolve({
          records: [],
          summary: {
            counters: {
              updates: () => ({
                nodesCreated: 0,
                nodesDeleted: 0,
                relationshipsCreated: 0,
                relationshipsDeleted: 0,
                propertiesSet: 0,
              }),
            },
          },
        });
      },
    ),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
}

function makeOgm(
  recorded: Recorded[],
  opts: {
    policies?: typeof policies | typeof tenantCheck;
    strict?: boolean;
    onDeny?: 'empty' | 'throw';
  } = {},
): OGM {
  return new OGM({
    typeDefs: schema,
    driver: createMockDriver(recorded),
    policies: opts.policies,
    strict: opts.strict,
    policyDefaults: opts.onDeny ? { onDeny: opts.onDeny } : undefined,
  });
}

async function denied(fn: () => Promise<unknown>): Promise<PolicyDeniedError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof PolicyDeniedError) return e;
    throw e;
  }
  throw new Error('expected PolicyDeniedError');
}

describe('v2.10.1 — runtime labels naming a declared type', () => {
  describe('create', () => {
    it('denies a label naming a type the context may not create (default deny), writing nothing', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      const e = await denied(() =>
        ogm
          .withContext(user)
          .model('Pub')
          .create({ input: [{ title: 'forged' }], labels: ['Secret'] }),
      );
      expect(e.typeName).toBe('Secret');
      expect(e.operation).toBe('create');
      expect(e.reason).toBe('no-permissive-matched');
      expect(e.message).toContain('Pub.create');
      expect(recorded).toHaveLength(0);
    });

    it("runs the named type's create WITH CHECK on every input", async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies: tenantCheck });
      const e = await denied(() =>
        ogm
          .withContext(user)
          .model('Pub')
          .create({
            input: [
              { title: 'ok', tenantId: 't1' },
              { title: 'other', tenantId: 't2' },
            ],
            labels: ['Secret'],
          }),
      );
      expect(e.reason).toBe('restrictive-rejected-input');
      expect(e.policyName).toBe('secret.create-tenant');
      expect(recorded).toHaveLength(0);

      await ogm
        .withContext(user)
        .model('Pub')
        .create({
          input: [{ title: 'ok', tenantId: 't1' }],
          labels: ['Secret'],
        });
      expect(recorded).toHaveLength(1);
      expect(recorded[0].cypher).toContain('SET n:`Secret`');
    });

    it('allows a context the named type lets create, and lists its policies in the audit metadata', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      await ogm
        .withContext(admin)
        .model('Pub')
        .create({ input: [{ title: 'legit' }], labels: ['Secret'] });
      expect(recorded).toHaveLength(1);
      expect(recorded[0].cypher).toContain('SET n:`Secret`');
      expect(recorded[0].config?.metadata?.policiesEvaluated).toEqual([
        'secret.admin-writes',
        'secret.create-admin-check',
      ]);
    });

    it('leaves a label no declared type carries alone', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      await ogm
        .withContext(user)
        .model('Pub')
        .create({ input: [{ title: 'tagged' }], labels: ['Archived'] });
      expect(recorded).toHaveLength(1);
      expect(recorded[0].cypher).toContain('SET n:`Archived`');
      expect(recorded[0].config?.metadata?.policiesEvaluated).toEqual([]);
    });

    it('applies interface policies through an implementer label, only when the node will carry all of its labels', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      // `Res` alone: the created node is not a `Multi` (lacks `Multi`).
      await ogm
        .withContext(user)
        .model('Pub')
        .create({ input: [{ title: 'r' }], labels: ['Res'] });
      expect(recorded).toHaveLength(1);
      // `Res` + `Multi`: a `Multi`, whose create policy comes from `Res`.
      const e = await denied(() =>
        ogm
          .withContext(user)
          .model('Pub')
          .create({ input: [{ title: 'm' }], labels: ['Res', 'Multi'] }),
      );
      expect(e.typeName).toBe('Multi');
      expect(recorded).toHaveLength(1);
      await ogm
        .withContext(admin)
        .model('Pub')
        .create({ input: [{ title: 'm' }], labels: ['Res', 'Multi'] });
      expect(recorded).toHaveLength(2);
      expect(recorded[1].config?.metadata?.policiesEvaluated).toEqual([
        'res.create-admin',
      ]);
    });

    it('is skipped by a per-call bypass', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      await ogm
        .withContext(user)
        .model('Pub')
        .create({
          input: [{ title: 'migrated' }],
          labels: ['Secret'],
          unsafe: { bypassPolicies: true },
        });
      expect(recorded).toHaveLength(1);
      expect(recorded[0].config?.metadata?.bypassed).toBe(true);
    });
  });

  describe('createMany', () => {
    it('denies a label naming a type the context may not create', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      const e = await denied(() =>
        ogm
          .withContext(user)
          .model('Pub')
          .createMany({
            data: [{ title: 'a' }, { title: 'b' }],
            labels: ['Secret'],
          }),
      );
      expect(e.typeName).toBe('Secret');
      expect(e.message).toContain('Pub.createMany');
      expect(recorded).toHaveLength(0);
    });

    it('with skipDuplicates, relabels a matched node into another type only where the root update AND read filters pass', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      // An admin: the root `create` on Secret itself must be allowed.
      await ogm
        .withContext(admin)
        .model('Secret')
        .createMany({
          data: [{ id: 's1', title: 'x' }],
          skipDuplicates: true,
          labels: ['Pub'],
        });
      const guard =
        /FOREACH \(__l IN CASE WHEN (.+) THEN \[1\] ELSE \[\] END \| SET n:`Pub`\)/.exec(
          recorded[0].cypher,
        );
      expect(guard).not.toBeNull();
      expect(guard![1]).toMatch(/n\.`tenantId` = \$param\d+/);
      expect(guard![1]).toMatch(/n\.`ownerId` = \$param\d+/);
      expect(Object.values(recorded[0].params)).toEqual(
        expect.arrayContaining(['t1', 'adm']),
      );
      expect(recorded[0].config?.metadata?.policiesEvaluated).toEqual([
        'secret.admin-writes',
        'secret.create-admin-check',
        'secret.read-own',
      ]);

      // An undeclared label keeps the v2.6.1 guard: update filter only.
      await ogm
        .withContext(admin)
        .model('Secret')
        .createMany({
          data: [{ id: 's1', title: 'x' }],
          skipDuplicates: true,
          labels: ['Archived'],
        });
      expect(recorded[1].cypher).toMatch(/n\.`tenantId` = \$param\d+/);
      expect(recorded[1].cypher).not.toContain('ownerId');
    });
  });

  describe('upsert', () => {
    it('denies a label naming a type the context may not create', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      const e = await denied(() =>
        ogm
          .withContext(user)
          .model('Pub')
          .upsert({
            where: { id: 'p1' },
            create: { title: 'a' },
            update: { title: 'b' },
            labels: ['Secret'],
          }),
      );
      expect(e.typeName).toBe('Secret');
      expect(e.message).toContain('Pub.upsert');
      expect(recorded).toHaveLength(0);
    });

    it('checks WITH CHECK on the update input too in default mode (the matched node is relabelled), not in strict mode', async () => {
      const recorded: Recorded[] = [];
      const call = (ogm: OGM) =>
        ogm
          .withContext(user)
          .model('Pub')
          .upsert({
            where: { id: 'p1' },
            create: { title: 'a', tenantId: 't1' },
            update: { title: 'b' },
            labels: ['Secret'],
          });
      const e = await denied(() =>
        call(makeOgm(recorded, { policies: tenantCheck })),
      );
      expect(e.policyName).toBe('secret.create-tenant');
      expect(recorded).toHaveLength(0);

      await call(makeOgm(recorded, { policies: tenantCheck, strict: true }));
      expect(recorded).toHaveLength(1);
      expect(recorded[0].cypher).toContain('ON CREATE SET');
      expect(recorded[0].cypher).toContain('n:`Secret`');
    });

    it('gates the matched node on the root update AND read filters when relabelling it into another type', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      // An admin: the root `create` on Secret itself must be allowed.
      await ogm
        .withContext(admin)
        .model('Secret')
        .upsert({
          where: { id: 's1' },
          create: { title: 'a' },
          update: { title: 'b' },
          labels: ['Pub'],
        });
      const guard = /WHERE NOT __matched OR \((.+)\)\n/.exec(
        recorded[0].cypher,
      );
      expect(guard).not.toBeNull();
      expect(guard![1]).toMatch(/n\.`tenantId` = \$param\d+/);
      expect(guard![1]).toMatch(/n\.`ownerId` = \$param\d+/);
      expect(recorded[0].cypher).toContain('SET n:`Pub`');
      expect(recorded[0].config?.metadata?.policiesEvaluated).toEqual([
        'secret.admin-writes',
        'secret.update-tenant',
        'secret.read-own',
      ]);
    });
  });

  describe('setLabels', () => {
    it('addLabels naming a type the context may not create throws before compile', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      const e = await denied(() =>
        ogm
          .withContext(user)
          .model('Pub')
          .setLabels({ where: { id: 'p1' }, addLabels: ['Secret'] }),
      );
      expect(e.typeName).toBe('Secret');
      expect(e.operation).toBe('create');
      expect(e.message).toContain('Pub.setLabels');
      expect(recorded).toHaveLength(0);
    });

    it("addLabels runs the named type's create WITH CHECK on an empty input", async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies: tenantCheck });
      const e = await denied(() =>
        ogm
          .withContext(user)
          .model('Pub')
          .setLabels({ where: { id: 'p1' }, addLabels: ['Secret'] }),
      );
      expect(e.reason).toBe('restrictive-rejected-input');
      expect(e.policyName).toBe('secret.create-tenant');
      expect(e.message).toContain('empty input');
      expect(recorded).toHaveLength(0);
    });

    it('addLabels naming a type the context may create compiles, listing its policies', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      await ogm
        .withContext(admin)
        .model('Pub')
        .setLabels({ where: { id: 'p1' }, addLabels: ['Secret'] });
      expect(recorded).toHaveLength(1);
      // Pub has no read policy: no extra row filter.
      expect(recorded[0].cypher).toBe(
        'MATCH (n:`Pub`)\nWHERE n.`id` = $param0\nSET n:`Secret`',
      );
      expect(recorded[0].config?.metadata?.policiesEvaluated).toEqual([
        'secret.admin-writes',
        'secret.create-admin-check',
      ]);
    });

    it("addLabels naming another declared type also requires the root type's read filter", async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      await ogm
        .withContext(user)
        .model('Secret')
        .setLabels({ where: { id: 's1' }, addLabels: ['Pub'] });
      const { cypher, params, config } = recorded[0];
      expect(cypher).toMatch(
        /^MATCH \(n:`Secret`\)\nWHERE \(\(n\.`id` = \$param0\) AND .*n\.`tenantId` = \$param\d+.*\) AND \(.*n\.`ownerId` = \$param\d+.*\)\nSET n:`Pub`$/s,
      );
      expect(Object.values(params)).toEqual(
        expect.arrayContaining(['s1', 't1', 'u1']),
      );
      expect(config?.metadata?.policiesEvaluated).toEqual([
        'secret.update-tenant',
        'secret.read-own',
      ]);
    });

    it('addLabels of an undeclared label keeps the update filter only', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      await ogm
        .withContext(user)
        .model('Secret')
        .setLabels({ where: { id: 's1' }, addLabels: ['Archived'] });
      expect(recorded[0].cypher).toMatch(/n\.`tenantId` = \$param\d+/);
      expect(recorded[0].cypher).not.toContain('ownerId');
      expect(recorded[0].config?.metadata?.policiesEvaluated).toEqual([
        'secret.update-tenant',
      ]);
    });

    it('a context with no read permissive relabels nothing (empty) or throws (throw)', async () => {
      const recorded: Recorded[] = [];
      await makeOgm(recorded, { policies })
        .withContext(blind)
        .model('Secret')
        .setLabels({ where: { id: 's1' }, addLabels: ['Pub'] });
      expect(recorded[0].cypher).toContain(') AND (false)');

      const e = await denied(() =>
        makeOgm(recorded, { policies, onDeny: 'throw' })
          .withContext(blind)
          .model('Secret')
          .setLabels({ where: { id: 's1' }, addLabels: ['Pub'] }),
      );
      expect(e.typeName).toBe('Secret');
      expect(e.operation).toBe('read');
      expect(recorded).toHaveLength(1);
    });

    it("removeLabels naming another declared type requires that type's delete filter on nodes that carry it", async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      await ogm
        .withContext(user)
        .model('Pub')
        .setLabels({ where: { id: 'p1' }, removeLabels: ['Secret'] });
      // No delete permissive applies to a user: only non-Secret nodes pass.
      expect(recorded[0].cypher).toBe(
        'MATCH (n:`Pub`)\nWHERE (n.`id` = $param0) AND (NOT n:`Secret` OR false)\nREMOVE n:`Secret`',
      );

      await ogm
        .withContext(admin)
        .model('Pub')
        .setLabels({ where: { id: 'p1' }, removeLabels: ['Secret'] });
      expect(recorded[1].cypher).not.toContain('false');
      expect(recorded[1].config?.metadata?.policiesEvaluated).toEqual([
        'secret.admin-writes',
      ]);

      const e = await denied(() =>
        makeOgm(recorded, { policies, onDeny: 'throw' })
          .withContext(user)
          .model('Pub')
          .setLabels({ where: { id: 'p1' }, removeLabels: ['Secret'] }),
      );
      expect(e.typeName).toBe('Secret');
      expect(e.operation).toBe('delete');
      expect(recorded).toHaveLength(2);
    });

    it("removeLabels of the root type's own label requires its delete filter", async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      await ogm
        .withContext(user)
        .model('Secret')
        .setLabels({ where: { id: 's1' }, removeLabels: ['Secret'] });
      expect(recorded[0].cypher).toMatch(
        /^MATCH \(n:`Secret`\)\nWHERE \(\(n\.`id` = \$param0\) AND .*tenantId.*\) AND \(false\)\nREMOVE n:`Secret`$/s,
      );
    });

    it('an existing node may carry further labels: a shared label of a multi-label type counts', async () => {
      const recorded: Recorded[] = [];
      const ogm = makeOgm(recorded, { policies });
      const e = await denied(() =>
        ogm
          .withContext(user)
          .model('Pub')
          .setLabels({ where: { id: 'p1' }, addLabels: ['Res'] }),
      );
      expect(e.typeName).toBe('Multi');
      expect(recorded).toHaveLength(0);
    });
  });

  describe('byte-identical without a policy binding', () => {
    const cases: Array<[string, (ogm: OGM) => Promise<unknown>]> = [
      [
        'create with labels',
        (ogm) =>
          ogm
            .model('Pub')
            .create({ input: [{ title: 'a' }], labels: ['Secret', 'X'] }),
      ],
      [
        'createMany with skipDuplicates and labels',
        (ogm) =>
          ogm.model('Pub').createMany({
            data: [{ id: 'p1', title: 'a' }],
            skipDuplicates: true,
            labels: ['Secret'],
          }),
      ],
      [
        'upsert with labels',
        (ogm) =>
          ogm.model('Secret').upsert({
            where: { id: 's1' },
            create: { title: 'a' },
            update: { title: 'b' },
            labels: ['Pub'],
          }),
      ],
      [
        'setLabels add + remove',
        (ogm) =>
          ogm.model('Pub').setLabels({
            where: { id: 'p1' },
            addLabels: ['Secret'],
            removeLabels: ['Multi'],
          }),
      ],
    ];

    it.each(cases)('%s', async (_name, call) => {
      const plain: Recorded[] = [];
      const bound: Recorded[] = [];
      const bypassed: Recorded[] = [];
      await call(makeOgm(plain));
      // Policies configured, but the bare `ogm.model()` path has no binding.
      await call(makeOgm(bound, { policies }));
      // Global bypass.
      await call(makeOgm(bypassed, { policies }).unsafe.bypassPolicies());
      expect(bound[0].cypher).toBe(plain[0].cypher);
      expect(bound[0].params).toEqual(plain[0].params);
      expect(bypassed[0].cypher).toBe(plain[0].cypher);
      expect(bypassed[0].params).toEqual(plain[0].params);
    });
  });
});
