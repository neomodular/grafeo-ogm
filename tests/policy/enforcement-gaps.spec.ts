/**
 * Mock-driver regression tests for the NLS enforcement gaps closed in
 * v2.3.0 (openspec change fix-nls-enforcement-gaps). One test per gap;
 * the live counterpart is `tests/integration/nls-enforcement.spec.ts`.
 *
 * Assertions target the ENFORCEMENT, not exact strings: a target type's
 * policy predicate must appear where the target is matched, and policy
 * violations must be rejected before any query reaches the driver.
 */
import { Driver } from 'neo4j-driver';
import { OGMError } from '../../src/errors';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import { override, permissive } from '../../src/policy/types';
import {
  CTX,
  policies,
  typeDefs,
  type Ctx,
} from '../fixtures/nls-enforcement.fixture';

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function setup(withPolicies: boolean | Partial<typeof policies> = true) {
  const recorded: Recorded[] = [];
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      recorded.push({ cypher, params });
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
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const driver = {
    session: jest.fn().mockReturnValue(session),
  } as unknown as Driver;
  const ogm = new OGM({
    typeDefs,
    driver,
    ...(withPolicies === true
      ? { policies }
      : withPolicies
        ? { policies: withPolicies }
        : {}),
  });
  return {
    ogm,
    bound: (ctx: Ctx = CTX) => ogm.withContext(ctx),
    recorded,
  };
}

const SECRET = /`secret` = \$\w+/;
const OWNER = /`ownerId` = \$\w+/;
const PROTECTED = /`protected` = \$\w+/;

describe('H1 — an unprotected root still enforces target-type policies', () => {
  it('nested selection', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({ select: { id: true, charts: { select: { id: true } } } });
    expect(recorded[0].cypher).toMatch(SECRET);
  });

  it('traversal filter', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({ where: { charts_SOME: { id: 'c1' } } });
    expect(recorded[0].cypher).toMatch(SECRET);
  });

  it('connect in update', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        connect: { charts: [{ where: { node: { id: 'c1' } } }] },
      });
    expect(recorded[0].cypher).toMatch(SECRET);
  });

  it('disconnect in update', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        disconnect: { charts: [{ where: { node: { id: 'c1' } } }] },
      });
    expect(recorded[0].cypher).toMatch(SECRET);
  });

  it('connect in create', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .create({
        input: [
          {
            id: 't9',
            charts: { connect: [{ where: { node: { id: 'c1' } } }] },
          },
        ],
      });
    expect(recorded[0].cypher).toMatch(SECRET);
  });

  it('explainPolicies selection on an unprotected root', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .explainPolicies({
        select: { id: true, charts: { select: { id: true } } },
      });
    expect(recorded[0].cypher).toMatch(SECRET);
  });

  it('a firing override on the root never disables target-type enforcement', async () => {
    const recorded: Recorded[] = [];
    const session = {
      run: jest.fn((cypher: string, params: Record<string, unknown>) => {
        recorded.push({ cypher, params });
        return Promise.resolve({ records: [] });
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const ogm = new OGM({
      typeDefs,
      driver: {
        session: jest.fn().mockReturnValue(session),
      } as unknown as Driver,
      policies: {
        ...policies,
        ItCategory: [
          override({ operations: ['read'], name: 'admin', when: () => true }),
          ...policies.ItCategory,
        ],
      },
    });
    await ogm
      .withContext(CTX)
      .model('ItCategory')
      .find({ select: { id: true, charts: { select: { id: true } } } });
    const lines = recorded[0].cypher.split('\n');
    // No root clause (override) …
    expect(lines.some((l) => l.startsWith('WHERE'))).toBe(false);
    // … but the nested ItChart read policy still applies.
    expect(recorded[0].cypher).toMatch(SECRET);
  });

  it('count() still falls back to read policies when no aggregate policy exists', async () => {
    const { bound, recorded } = setup();
    await bound().model('ItChart').count();
    expect(recorded[0].cypher).toMatch(SECRET);
  });

  it('stays byte-identical when no protected type is reached', async () => {
    const withP = setup(true);
    const without = setup(false);
    const call = { where: { id: 't1' }, select: { id: true } };
    await withP.bound().model('ItTag').find(call);
    await without.bound().model('ItTag').find(call);
    expect(withP.recorded[0].cypher).toBe(without.recorded[0].cypher);
    expect(withP.recorded[0].params).toEqual(without.recorded[0].params);
  });
});

describe('H4 — cascade delete', () => {
  it("honors the per-relationship where and the target's delete policy", async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItChart')
      .delete({
        where: { id: 'c1' },
        delete: { categories: [{ where: { node: { name: 'Temp' } } }] },
      });
    const { cypher, params } = recorded[0];
    expect(cypher).toMatch(/`name` = \$\w+/);
    expect(Object.values(params)).toContain('Temp');
    expect(cypher).toMatch(PROTECTED);
  });

  it("gates a `{}` cascade by the target's delete policy", async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItChart')
      .delete({ where: { id: 'c1' }, delete: { categories: [{}] } });
    expect(recorded[0].cypher).toMatch(PROTECTED);
  });

  it('rejects multi-level cascade before running anything', async () => {
    const { bound, recorded } = setup();
    await expect(
      bound()
        .model('ItChart')
        .delete({
          where: { id: 'c1' },
          delete: { categories: [{ delete: { charts: [{}] } }] },
        }),
    ).rejects.toThrow(OGMError);
    expect(recorded).toHaveLength(0);
  });

  it('rejects unknown delete-spec keys', async () => {
    const { bound, recorded } = setup();
    await expect(
      bound()
        .model('ItChart')
        .delete({
          where: { id: 'c1' },
          delete: { categories: [{ wher: { node: { name: 'x' } } }] },
        }),
    ).rejects.toThrow(/wher/);
    expect(recorded).toHaveLength(0);
  });
});

describe('H4 — cascade delete edge cases', () => {
  it('accepts a singular (object) spec for a relationship', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItChart')
      .delete({
        where: { id: 'c1' },
        delete: { categories: { where: { node: { name: 'Temp' } } } },
      });
    expect(recorded[0].cypher).toMatch(PROTECTED);
    expect(Object.values(recorded[0].params)).toContain('Temp');
  });

  it("onDeny 'throw': a nested update with no applicable target permissive throws before running", async () => {
    const recorded: Recorded[] = [];
    const ogm = new OGM({
      typeDefs,
      driver: {
        session: jest.fn().mockReturnValue({
          run: jest.fn((cypher: string, params: Record<string, unknown>) => {
            recorded.push({ cypher, params });
            return Promise.resolve({ records: [] });
          }),
          close: jest.fn().mockResolvedValue(undefined),
        }),
      } as unknown as Driver,
      policyDefaults: { onDeny: 'throw' },
      policies: {
        ...policies,
        ItChart: [
          permissive({
            operations: ['update'],
            name: 'chart.update-admin',
            appliesWhen: () => false,
            when: () => ({}),
          }),
        ],
      },
    });
    await expect(
      ogm
        .withContext(CTX)
        .model('ItCategory')
        .update({
          where: { id: 'k1' },
          update: { charts: [{ update: { node: { title: 'x' } } }] },
        }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(recorded).toHaveLength(0);
  });
});

describe('Nested writes enforce the target type as a direct write would', () => {
  it("nested update carries the target's update row filter", async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItCategory')
      .update({
        where: { id: 'k1' },
        update: {
          charts: [{ where: { node: {} }, update: { node: { title: 'x' } } }],
        },
      });
    expect(recorded[0].cypher).toMatch(OWNER);
  });

  it("nested update is rejected by the target's WITH CHECK before running", async () => {
    const { bound, recorded } = setup();
    await expect(
      bound()
        .model('ItCategory')
        .update({
          where: { id: 'k1' },
          update: {
            charts: [{ update: { node: { tenantId: 'other' } } }],
          },
        }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(recorded).toHaveLength(0);
  });

  it("nested create in update needs the target's create permissive", async () => {
    const { bound, recorded } = setup();
    await expect(
      bound()
        .model('ItCategory')
        .update({
          where: { id: 'k1' },
          update: {
            charts: [{ create: [{ node: { id: 'n1', tenantId: 't1' } }] }],
          },
        }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(recorded).toHaveLength(0);
  });

  it("nested create in create is rejected by the target's WITH CHECK", async () => {
    const { bound, recorded } = setup();
    await expect(
      bound({ ...CTX, canCreateChart: true })
        .model('ItCategory')
        .create({
          input: [
            {
              id: 'k2',
              charts: { create: [{ node: { id: 'n2', tenantId: 'other' } }] },
            },
          ],
        }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(recorded).toHaveLength(0);
  });

  it('checks nested creates at any depth', async () => {
    // ItCategory → ItChart (allowed) → ItTag (no policies) → ItChart with
    // a foreign tenant: rejected three levels down.
    const { bound, recorded } = setup();
    await expect(
      bound({ ...CTX, canCreateChart: true })
        .model('ItCategory')
        .create({
          input: [
            {
              id: 'k3',
              charts: {
                create: [
                  {
                    node: {
                      id: 'n3',
                      tenantId: 't1',
                      tags: {
                        create: [
                          {
                            node: {
                              id: 't3',
                              charts: {
                                create: [
                                  { node: { id: 'n4', tenantId: 'other' } },
                                ],
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
    ).rejects.toMatchObject({
      name: 'PolicyDeniedError',
      typeName: 'ItChart',
      operation: 'create',
      policyName: 'chart.create-tenant',
    });
    expect(recorded).toHaveLength(0);
  });

  it('checks a single-object (non-array) nested create spec', async () => {
    const { bound, recorded } = setup();
    await expect(
      bound()
        .model('ItTag')
        .create({
          input: [
            {
              id: 't4',
              charts: { create: { node: { id: 'n5', tenantId: 't1' } } },
            },
          ],
        }),
    ).rejects.toMatchObject({
      typeName: 'ItChart',
      reason: 'no-permissive-matched',
    });
    expect(recorded).toHaveLength(0);
  });

  it('checks nested creates for a union member target', async () => {
    const { bound, recorded } = setup();
    await expect(
      bound()
        .model('ItTag')
        .update({
          where: { id: 't1' },
          update: {
            items: {
              ItChart: [{ create: [{ node: { id: 'n6', tenantId: 't1' } }] }],
            },
          },
        }),
    ).rejects.toMatchObject({ typeName: 'ItChart', operation: 'create' });
    expect(recorded).toHaveLength(0);
  });

  it('updateMany checks nested updates too', async () => {
    const { bound, recorded } = setup();
    await expect(
      bound()
        .model('ItCategory')
        .updateMany({
          where: { id: 'k1' },
          data: { charts: [{ update: { node: { tenantId: 'other' } } }] },
        }),
    ).rejects.toMatchObject({
      typeName: 'ItChart',
      operation: 'update',
      policyName: 'chart.update-tenant',
    });
    expect(recorded).toHaveLength(0);
  });

  it('lets a nested write through when the target allows it', async () => {
    const { bound, recorded } = setup();
    await bound({ ...CTX, canCreateChart: true })
      .model('ItCategory')
      .create({
        input: [
          {
            id: 'k4',
            charts: { create: [{ node: { id: 'n7', tenantId: 't1' } }] },
          },
        ],
      });
    expect(recorded).toHaveLength(1);
  });

  it("delete inside update carries the target's delete row filter", async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItCategory')
      .update({
        where: { id: 'k1' },
        update: { charts: [{ delete: [{ where: { node: {} } }] }] },
      });
    expect(recorded[0].cypher).toMatch(OWNER);
  });

  it("a traversal inside a nested-write where enforces the traversed type's read policy", async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItChart')
      .update({
        where: { id: 'c1' },
        disconnect: {
          tags: [{ where: { node: { charts_SOME: { id: 'c2' } } } }],
        },
      });
    // Root ItChart update has no read clause — any `secret` predicate is the
    // traversed ItChart read policy inside the disconnect filter.
    expect(recorded[0].cypher).toMatch(SECRET);
  });
});

describe('H3 — strict null semantics', () => {
  it('field_NOT: null compiles to IS NOT NULL (policy partial)', async () => {
    const { bound, recorded } = setup();
    await bound().model('ItDoc').find({});
    expect(recorded[0].cypher).toMatch(/`approvedAt` IS NOT NULL/);
    expect(recorded[0].cypher).not.toMatch(/approvedAt_NOT/);
  });

  it('relationship_NOT: null compiles to EXISTS', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({ where: { charts_NOT: null } });
    expect(recorded[0].cypher).toMatch(
      /(?<!NOT )EXISTS \{ MATCH \(n\)-\[:`IT_TAGS`\]->/,
    );
  });

  it('rejects an operator other than _NOT with null', async () => {
    const { bound, recorded } = setup();
    await expect(
      bound()
        .model('ItCategory')
        .find({ where: { name_CONTAINS: null } }),
    ).rejects.toThrow(/name_CONTAINS/);
    expect(recorded).toHaveLength(0);
  });

  it('rejects an unknown field with null even without strictWhere', async () => {
    const { bound, recorded } = setup();
    await expect(
      bound()
        .model('ItCategory')
        .find({ where: { namee: null } }),
    ).rejects.toThrow(/namee/);
    expect(recorded).toHaveLength(0);
  });

  it('applies the same semantics to nested-write where', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        disconnect: { charts: [{ where: { node: { title_NOT: null } } }] },
      });
    expect(recorded[0].cypher).toMatch(/`title` IS NOT NULL/);
  });
});

/** Chart read clause as composed for a traversal variable (`r0`, `r2`, …). */
const chartClause = (v: string) => `(true AND (${v}.\`secret\` = $p))`;

/** Parameter numbering is not what these tests pin — normalize it. */
const norm = (cypher: string) => cypher.replace(/\$param\d+/g, '$p');

describe('Traversal filters keep the target policy outside every negation', () => {
  const findTags = async (where: Record<string, unknown>) => {
    const { bound, recorded } = setup();
    await bound().model('ItTag').find({ where });
    return norm(recorded[0].cypher);
  };

  it('_ALL: hidden related nodes neither satisfy nor falsify the quantifier', async () => {
    const cypher = await findTags({ charts_ALL: { title: 'x' } });
    // A counterexample must be VISIBLE (policy) and fail the filter.
    expect(cypher).toContain(
      `WHERE ${chartClause('r0')} AND NOT (r0.\`title\` = $p) }`,
    );
  });

  it('_ALL with no filter is vacuous (no existence oracle)', async () => {
    // Protected root on purpose: pre-2.3.0 an unprotected root masked the
    // oracle behind H1, a protected one emitted
    // `NOT EXISTS { … WHERE NOT (<chart policy>) }`.
    const { bound, recorded } = setup();
    await bound()
      .model('ItCategory')
      .find({ where: { charts_ALL: {} } });
    expect(recorded[0].cypher).not.toContain('IT_IN_CATEGORY');
  });

  it('_NONE: the policy sits inside the positive EXISTS', async () => {
    const cypher = await findTags({ charts_NONE: { title: 'x' } });
    expect(cypher).toContain(
      `NOT EXISTS { MATCH (n)-[:\`IT_TAGS\`]->(r0:\`ItChart\`) WHERE (r0.\`title\` = $p) AND ${chartClause('r0')} }`,
    );
  });

  it('_SINGLE counts only visible matches', async () => {
    const cypher = await findTags({ charts_SINGLE: { title: 'x' } });
    expect(cypher).toMatch(
      /size\(\[r0 IN \[\(.* WHERE \(r0\.`title` = \$p\) AND \(true AND \(r0\.`secret` = \$p\)\) \| r0\)\] \| r0\]\) = 1/,
    );
  });

  it('connection node_NOT cannot be satisfied by hidden nodes', async () => {
    const cypher = await findTags({
      chartsConnection: { node_NOT: { id: 'c1' } },
    });
    expect(cypher).toContain(
      `WHERE (NOT (r0.\`id\` = $p)) AND ${chartClause('r0')} }`,
    );
  });

  it('an edge-only connection filter still applies the target policy', async () => {
    const cypher = await findTags({
      chartsConnection: { edge: { weight: 3 } },
    });
    expect(cypher).toMatch(
      /EXISTS \{ MATCH \(n\)-\[e0:`IT_TAGS`\]->\(r0:`ItChart`\) WHERE \(e0\.`weight` = \$p\) AND \(true AND \(r0\.`secret` = \$p\)\) \}/,
    );
  });

  it('Connection_ALL keeps the policy outside the negation', async () => {
    const cypher = await findTags({
      chartsConnection_ALL: { node: { title: 'x' } },
    });
    expect(cypher).toContain(
      `WHERE ${chartClause('r0')} AND NOT (r0.\`title\` = $p) }`,
    );
  });

  it('enforcement cascades through a policy-free middle type', async () => {
    // ItTag (none) → ItChart → ItTag (none) → ItChart: pre-2.3.0 the
    // middle ItTag dropped the bundle and the innermost chart was open.
    const cypher = await findTags({
      charts_SOME: { tags_SOME: { charts_SOME: { id: 'c1' } } },
    });
    expect(cypher).toContain(chartClause('r0'));
    expect(cypher).toContain(chartClause('r2'));
  });

  it('a selection connection node_NOT keeps traversals inside it enforcing', async () => {
    // Pre-2.3.0 the node_NOT branch compiled with NO policy context, so
    // the chart reached through it was unguarded.
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({
        select: {
          id: true,
          chartsConnection: {
            where: {
              node_NOT: { tags_SOME: { charts_SOME: { id: 'c1' } } },
            },
            select: { edges: { node: { select: { id: true } } } },
          },
        },
      });
    const cypher = norm(recorded[0].cypher);
    // n0: the projected chart (its policy outside the NOT); r1: the
    // policy-free middle tag; r2: the chart reached through the negation.
    expect(cypher).toContain(
      `WHERE ${chartClause('n0')} AND NOT (EXISTS { MATCH (n0)<-[:\`IT_TAGS\`]-(r1:\`ItTag\`)`,
    );
    expect(cypher).toContain(chartClause('r2'));
  });
});

describe('H5 — abstract relationship targets enforce each member policy', () => {
  const MEMBER_CASE =
    /CASE WHEN (\w+):`ItChart` THEN \(true AND \(\1\.`secret` = \$\w+\)\) WHEN \1:`ItDrug` THEN false ELSE false END/;

  it('interface target traversal filter', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({ where: { resources_SOME: { id: 'c1' } } });
    expect(recorded[0].cypher).toMatch(MEMBER_CASE);
  });

  it('interface target _ALL keeps the CASE outside the negation', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({ where: { resources_ALL: { id: 'c1' } } });
    expect(recorded[0].cypher).toMatch(/ELSE false END\) AND NOT \(r0\.`id`/);
  });

  it('interface target connection filter', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({ where: { resourcesConnection: { node: { id: 'c1' } } } });
    expect(recorded[0].cypher).toMatch(MEMBER_CASE);
  });

  it('union target traversal applies the member policy', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({ where: { items_SOME: { ItDoc: { id: 'd1' } } } });
    expect(recorded[0].cypher).toMatch(/`approvedAt` IS NOT NULL/);
  });

  it('union target _ALL keeps the member policy outside the negation', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({ where: { items_ALL: { ItChart: { title: 'x' } } } });
    expect(norm(recorded[0].cypher)).toContain(
      `WHERE ${chartClause('r0')} AND NOT (r0.\`title\` = $p) }`,
    );
  });

  it('interface target nested selection', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .find({ selectionSet: '{ id resources { id } }' });
    expect(recorded[0].cypher).toMatch(/CASE WHEN \w+:`ItChart` THEN/);
    expect(recorded[0].cypher).toMatch(SECRET);
  });

  it('union target nested selection', async () => {
    const { bound, recorded } = setup();
    await bound().model('ItTag').find({
      selectionSet:
        '{ id items { ... on ItChart { id } ... on ItDoc { id } } }',
    });
    expect(recorded[0].cypher).toMatch(SECRET);
    expect(recorded[0].cypher).toMatch(/`approvedAt` IS NOT NULL/);
  });

  it('interface target connect', async () => {
    const { bound, recorded } = setup();
    await bound()
      .model('ItTag')
      .update({
        where: { id: 't1' },
        connect: { resources: [{ where: { node: { id: 'c1' } } }] },
      });
    expect(recorded[0].cypher).toMatch(MEMBER_CASE);
  });

  it('stays free of policy clauses when no member has a policy', async () => {
    const { bound, recorded } = setup({ ItDoc: policies.ItDoc });
    const tags = bound().model('ItTag');
    await tags.find({ where: { resources_SOME: { id: 'c1' } } });
    await tags.find({ selectionSet: '{ id resources { id } }' });
    for (const { cypher } of recorded) expect(cypher).not.toContain('CASE');
  });
});

describe('H2 — interface branches', () => {
  it('denies an implementer whose permissives are all gated off', async () => {
    const { bound, recorded } = setup();
    await bound().interfaceModel('ItResource').find({});
    expect(recorded[0].cypher).toMatch(/WHEN n:`ItDrug` THEN false/);
  });
});
