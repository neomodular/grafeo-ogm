/**
 * v2.18.0 — `@id` on a `@relationshipProperties` field is generated when the
 * relationship is created (`randomUUID()`), in every mode, as a node's
 * `@id` is. Pre-v2.18.0 it was never generated: always null, though the
 * generated output type declares it non-null. The live half is
 * `tests/integration/edge-id-generation.spec.ts`.
 */
import { OGM } from '../src/ogm';
import { Executor } from '../src/execution/executor';

const typeDefs = /* GraphQL */ `
  type EiM @node {
    id: ID! @id
    name: String
    ks: [EiK!]! @relationship(type: "EI_MK", direction: OUT, properties: "EiMK")
    plain: [EiK!]!
      @relationship(type: "EI_PLAIN", direction: OUT, properties: "EiPlain")
  }
  type EiK @node {
    id: ID! @id
    name: String
  }
  type EiMK @relationshipProperties {
    eid: ID! @id
    note: String
  }
  type EiPlain @relationshipProperties {
    note: String
  }
`;

function capture(strict: boolean) {
  const calls: { cypher: string; params: Record<string, unknown> }[] = [];
  jest
    .spyOn(Executor.prototype, 'execute')
    .mockImplementation(
      async (cypher: string, params: Record<string, unknown>) => {
        calls.push({ cypher, params });
        return {
          records: [],
          summary: { counters: { updates: () => ({}) } },
        } as never;
      },
    );
  const ogm = new OGM({ typeDefs, driver: {} as never, strict });
  return { calls, M: ogm.model('EiM') };
}

afterEach(() => jest.restoreAllMocks());

describe.each([false, true])('edge @id generation (strict=%s)', (strict) => {
  it('nested create sets the edge id on the new relationship', async () => {
    const { calls, M } = capture(strict);
    await M.create({
      input: [
        {
          name: 'm',
          ks: { create: [{ node: { name: 'k' }, edge: { note: 'a' } }] },
        },
      ],
    });
    expect(calls[0].cypher).toMatch(
      /SET r_edge_\d+\.`note` = \$\S+, r_edge_\d+\.`eid` = randomUUID\(\)/,
    );
  });

  it('nested create without edge input still generates it', async () => {
    const { calls, M } = capture(strict);
    await M.create({
      input: [{ name: 'm', ks: { create: [{ node: { name: 'k' } }] } }],
    });
    expect(calls[0].cypher).toMatch(/SET r_edge_\d+\.`eid` = randomUUID\(\)/);
  });

  it('connect generates it ON CREATE only (an existing relationship keeps its id)', async () => {
    const { calls, M } = capture(strict);
    await M.update({
      where: { id: 'x' },
      connect: { ks: { where: { node: { name: 'k' } } } },
    });
    expect(calls[0].cypher).toContain('ON CREATE SET r.`eid` = randomUUID()');
  });

  it('array connect (UNWIND fast path) generates it ON CREATE', async () => {
    const { calls, M } = capture(strict);
    await M.update({
      where: { id: 'x' },
      connect: {
        ks: [
          { where: { node: { name: 'a' } }, edge: { note: 'n' } },
          { where: { node: { name: 'b' } }, edge: { note: 'm' } },
        ],
      },
    });
    expect(calls[0].cypher).toContain('ON CREATE SET r.`eid` = randomUUID()');
    expect(calls[0].cypher).toContain('SET r.`note` = connItem.edge.note');
  });

  it('nested create inside a nested update generates it', async () => {
    const { calls, M } = capture(strict);
    await M.update({
      where: { id: 'x' },
      update: { ks: [{ create: [{ node: { name: 'k' } }] }] },
    });
    expect(calls[0].cypher).toMatch(/_e\.`eid` = randomUUID\(\)/);
  });

  it.each([['given'], [null]])(
    'an explicit edge value (%s) wins, as for node @id',
    async (eid) => {
      const { calls, M } = capture(strict);
      await M.create({
        input: [
          {
            name: 'm',
            ks: { create: [{ node: { name: 'k' }, edge: { eid } as never }] },
          },
        ],
      });
      expect(calls[0].cypher).not.toMatch(/`eid` = randomUUID\(\)/);
      expect(calls[0].cypher).toMatch(/`eid` = \$\S+_edge_eid/);
    },
  );

  it('relationships without an edge @id compile as before', async () => {
    const { calls, M } = capture(strict);
    await M.create({
      input: [{ name: 'm', plain: { create: [{ node: { name: 'k' } }] } }],
    });
    expect(calls[0].cypher).not.toContain('r_edge_');
    await M.update({
      where: { id: 'x' },
      connect: { plain: { where: { node: { name: 'k' } } } },
    });
    expect(calls[1].cypher).not.toContain('ON CREATE SET');
  });
});
