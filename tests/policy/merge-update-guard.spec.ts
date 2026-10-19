/**
 * v2.6.1 — MERGE-based writes apply the root type's `update` ROW filter to
 * the node the MERGE matches (finding F7). Pre-2.6.1 `upsert` put the
 * update in `ON MATCH SET` with no policy predicate, so any context the
 * WITH CHECK admitted rewrote any existing node; createMany with
 * skipDuplicates relabelled every matched node. The live outcome is pinned
 * in `tests/integration/nls-enforcement.spec.ts`; this suite pins the
 * emitted clause shape.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../../src/ogm';
import { PolicyDeniedError } from '../../src/policy/errors';
import { override, permissive, restrictive } from '../../src/policy/types';

const schema = `
type Book @node {
  id: ID! @id @unique
  title: String!
  ownerId: String
  rank: Int @cypher(statement: "RETURN 1 AS r", columnName: "r")
}
`;

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function createMockDriver(records: Recorded[]): Driver {
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      records.push({ cypher, params });
      return Promise.resolve({
        records: [],
        summary: {
          counters: {
            updates: () => ({
              nodesCreated: 0,
              nodesDeleted: 0,
              relationshipsCreated: 0,
              relationshipsDeleted: 0,
            }),
          },
        },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { session: jest.fn().mockReturnValue(session) } as unknown as Driver;
}

const ownerUpdate = permissive({
  operations: ['update'],
  name: 'book.update-own',
  when: (c) => ({ ownerId: (c as { uid: string }).uid }),
});
const createAll = permissive({
  operations: ['create'],
  when: () => ({}),
});

function build(
  policies: Record<string, unknown[]> | undefined,
  extra: Record<string, unknown> = {},
) {
  const recorded: Recorded[] = [];
  const ogm = new OGM({
    typeDefs: schema,
    driver: createMockDriver(recorded),
    ...(policies ? { policies: policies as never } : {}),
    ...extra,
  });
  return { ogm, recorded };
}

const upsertArgs = {
  where: { id: 'b1' },
  create: { title: 'x' },
  update: { title: 'y' },
  selectionSet: '{ id }',
};

describe('v2.6.1 — upsert applies the update row filter to the matched node', () => {
  it('emits the guarded MERGE', async () => {
    const { ogm, recorded } = build({ Book: [ownerUpdate, createAll] });
    await ogm.withContext({ uid: 'u1' }).model('Book').upsert(upsertArgs);
    expect(recorded[0].cypher).toBe(
      [
        'OPTIONAL MATCH (__existing:`Book` { `id`: $merge_id })',
        'WITH count(__existing) > 0 AS __matched',
        'MERGE (n:`Book` { `id`: $merge_id })',
        'ON CREATE SET n.`title` = $onCreate_title',
        'WITH n, __matched',
        'WHERE NOT __matched OR ((n.`ownerId` = $param0))',
        'FOREACH (__u IN CASE WHEN __matched THEN [1] ELSE [] END | SET n.`title` = $onMatch_title)',
        'RETURN n { .`id` }',
      ].join('\n'),
    );
    expect(recorded[0].params).toMatchObject({
      merge_id: 'b1',
      onCreate_title: 'x',
      onMatch_title: 'y',
      param0: 'u1',
    });
  });

  it('uses the same clause a direct update puts in its WHERE', async () => {
    const { ogm, recorded } = build({ Book: [ownerUpdate, createAll] });
    const m = ogm.withContext({ uid: 'u1' }).model('Book');
    await m.update({
      where: { id: 'b1' },
      update: { title: 'y' },
      selectionSet: '{ id }',
    });
    await m.upsert(upsertArgs);
    expect(recorded[0].cypher).toContain('(n.`ownerId` = $param1)');
    expect(recorded[1].cypher).toContain('(n.`ownerId` = $param0)');
  });

  it('ORs the update permissives; WITH CHECK restrictives stay input checks', async () => {
    const { ogm, recorded } = build({
      Book: [
        ownerUpdate,
        permissive({ operations: ['update'], when: () => ({ title: 'open' }) }),
        restrictive({
          operations: ['update'],
          name: 'book.no-owner-change',
          when: (_c, input) => input.ownerId === undefined,
        }),
        createAll,
      ],
    });
    const m = ogm.withContext({ uid: 'u1' }).model('Book');
    await m.upsert(upsertArgs);
    await m.update({
      where: { id: 'b1' },
      update: { title: 'y' },
      selectionSet: '{ id }',
    });
    const guard = /WHERE NOT __matched OR \((.*)\)$/m.exec(
      recorded[0].cypher,
    )![1];
    expect(guard).toBe('((n.`ownerId` = $param0) OR (n.`title` = $param1))');
    expect(recorded[1].cypher).toContain(
      'AND ((n.`ownerId` = $param1) OR (n.`title` = $param2))',
    );
    await expect(
      m.upsert({ ...upsertArgs, update: { ownerId: 'u2' } }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
  });

  it('an update with no scalar sets still filters the matched node (no FOREACH)', async () => {
    const { ogm, recorded } = build({ Book: [ownerUpdate, createAll] });
    await ogm
      .withContext({ uid: 'u1' })
      .model('Book')
      .upsert({ ...upsertArgs, update: {} });
    expect(recorded[0].cypher).toContain(
      'WHERE NOT __matched OR ((n.`ownerId` = $param0))',
    );
    expect(recorded[0].cypher).not.toContain('FOREACH');
    expect(recorded[0].cypher).not.toContain('ON MATCH SET');
  });

  it('default-mode runtime labels are SET after the guard', async () => {
    const { ogm, recorded } = build({ Book: [ownerUpdate, createAll] });
    await ogm
      .withContext({ uid: 'u1' })
      .model('Book')
      .upsert({ ...upsertArgs, labels: ['Extra'] });
    const lines = recorded[0].cypher.split('\n');
    expect(lines.indexOf('SET n:`Extra`')).toBeGreaterThan(
      lines.findIndex((l) => l.startsWith('WHERE NOT __matched')),
    );
  });

  it("carries __matched through the guard's @cypher preludes", async () => {
    const { ogm, recorded } = build({
      Book: [
        permissive({ operations: ['update'], when: () => ({ rank_GT: 0 }) }),
        createAll,
      ],
    });
    await ogm.withContext({}).model('Book').upsert(upsertArgs);
    const cypher = recorded[0].cypher;
    expect(cypher).toMatch(/WITH n, __matched\nCALL \{/);
    expect(cypher).toMatch(
      /WITH n, __matched, __where_n_rank\nWHERE NOT __matched OR/,
    );
  });

  it('no update permissive applies, onDeny "empty": a matched node is never updated', async () => {
    const { ogm, recorded } = build({
      Book: [
        permissive({
          operations: ['update'],
          appliesWhen: () => false,
          when: () => ({}),
        }),
        createAll,
      ],
    });
    await ogm.withContext({}).model('Book').upsert(upsertArgs);
    expect(recorded[0].cypher).toContain('WHERE NOT __matched OR (false)');
  });

  it('no update permissive applies, onDeny "throw": throws before compile, as update does', async () => {
    const { ogm, recorded } = build(
      {
        Book: [
          permissive({
            operations: ['update'],
            appliesWhen: () => false,
            when: () => ({}),
          }),
          createAll,
        ],
      },
      { policyDefaults: { onDeny: 'throw' } },
    );
    const m = ogm.withContext({}).model('Book');
    await expect(
      m.update({ where: { id: 'b1' }, update: { title: 'y' } }),
    ).rejects.toBeInstanceOf(PolicyDeniedError);
    await expect(m.upsert(upsertArgs)).rejects.toBeInstanceOf(
      PolicyDeniedError,
    );
    expect(recorded).toHaveLength(0);
  });

  it('a type without an update policy compiles the MERGE exactly as an unbound OGM does', async () => {
    const bound = build({ Book: [createAll] });
    const plain = build(undefined);
    await bound.ogm.withContext({}).model('Book').upsert(upsertArgs);
    await plain.ogm.model('Book').upsert(upsertArgs);
    expect(bound.recorded[0].cypher).toBe(plain.recorded[0].cypher);
    expect(plain.recorded[0].cypher).toContain('ON MATCH SET');
    expect(plain.recorded[0].cypher).not.toContain('__matched');
  });

  it('an override that fires compiles the MERGE without a guard', async () => {
    const { ogm, recorded } = build({
      Book: [
        ownerUpdate,
        createAll,
        override({ operations: ['*'], when: () => true }),
      ],
    });
    await ogm.withContext({ uid: 'u1' }).model('Book').upsert(upsertArgs);
    expect(recorded[0].cypher).not.toContain('__matched');
  });

  it('per-call unsafe.bypassPolicies compiles the MERGE without a guard', async () => {
    const { ogm, recorded } = build({ Book: [ownerUpdate, createAll] });
    await ogm
      .withContext({ uid: 'u1' })
      .model('Book')
      .upsert({ ...upsertArgs, unsafe: { bypassPolicies: true } });
    expect(recorded[0].cypher).not.toContain('__matched');
  });
});

describe('v2.6.1 — createMany skipDuplicates relabels a matched node only past the update row filter', () => {
  const data = [{ id: 'b1', title: 'x' }];

  it('labels go in ON CREATE SET and, for matched nodes, behind the guard', async () => {
    const { ogm, recorded } = build({ Book: [ownerUpdate, createAll] });
    await ogm
      .withContext({ uid: 'u1' })
      .model('Book')
      .createMany({ data, skipDuplicates: true, labels: ['Extra'] });
    expect(recorded[0].cypher).toBe(
      [
        'UNWIND $items AS item',
        'MERGE (n:`Book` { `id`: item.`id` })',
        'ON CREATE SET n.`title` = item.`title`, n:`Extra`',
        'WITH n',
        'FOREACH (__l IN CASE WHEN (n.`ownerId` = $param0) THEN [1] ELSE [] END | SET n:`Extra`)',
        'RETURN count(n) AS count',
      ].join('\n'),
    );
    expect(recorded[0].params).toMatchObject({ param0: 'u1' });
  });

  it('without labels, or without skipDuplicates, the Cypher is unchanged', async () => {
    const bound = build({ Book: [ownerUpdate, createAll] });
    const plain = build(undefined);
    const b = bound.ogm.withContext({ uid: 'u1' }).model('Book');
    const p = plain.ogm.model('Book');
    await b.createMany({ data, skipDuplicates: true });
    await p.createMany({ data, skipDuplicates: true });
    await b.createMany({ data, labels: ['Extra'] });
    await p.createMany({ data, labels: ['Extra'] });
    expect(bound.recorded.map((r) => r.cypher)).toEqual(
      plain.recorded.map((r) => r.cypher),
    );
  });

  it('a context with no update permissive relabels no matched node and does not throw', async () => {
    const { ogm, recorded } = build(
      {
        Book: [
          permissive({
            operations: ['update'],
            appliesWhen: () => false,
            when: () => ({}),
          }),
          createAll,
        ],
      },
      { policyDefaults: { onDeny: 'throw' } },
    );
    await ogm
      .withContext({})
      .model('Book')
      .createMany({ data, skipDuplicates: true, labels: ['Extra'] });
    expect(recorded[0].cypher).toContain(
      'FOREACH (__l IN CASE WHEN false THEN [1] ELSE [] END | SET n:`Extra`)',
    );
  });
});
