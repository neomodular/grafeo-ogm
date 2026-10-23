/**
 * v2.12.4 — process-wide caches are keyed by schema identity.
 *
 * Pre-2.12.4 the `resolveTargetDef` cache (src/schema/utils.ts) was keyed by
 * type name only and `Model._selectionCache` (src/model.ts) by selectionSet
 * string only. Two OGMs with different schemas in one process shared
 * entries, so OGM B's output depended on whether OGM A had run first.
 *
 * Every case runs B alone, then A followed by B, and expects B to behave
 * identically (Cypher, params, warnings, errors).
 */
import { Driver } from 'neo4j-driver';
import { Model } from '../src/model';
import { OGM } from '../src/ogm';
import { clearResolveTargetDefCache } from '../src/schema/utils';

interface Recorded {
  cypher: string;
  params: Record<string, unknown>;
}

function mockDriver(records: Recorded[]): Driver {
  const session = {
    run: jest.fn((cypher: string, params: Record<string, unknown>) => {
      records.push({ cypher, params });
      return Promise.resolve({
        records: [],
        summary: { counters: { updates: () => ({}) } },
      });
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  return { session: jest.fn().mockReturnValue(session) } as unknown as Driver;
}

interface Outcome {
  results: Array<{ cypher?: string; params?: unknown; error?: string }>;
  warnings: string[];
}

async function runWith(
  typeDefs: string,
  strict: boolean,
  ops: Array<(ogm: OGM) => Promise<unknown>>,
): Promise<Outcome> {
  const records: Recorded[] = [];
  const warnings: string[] = [];
  const logger = {
    debug: jest.fn(),
    warn: jest.fn((msg: string) => {
      warnings.push(String(msg));
    }),
  };
  const ogm = new OGM({
    typeDefs,
    driver: mockDriver(records),
    logger,
    strict,
  });
  const results: Outcome['results'] = [];
  for (const op of ops) {
    const before = records.length;
    try {
      await op(ogm);
      const last = records[records.length - 1];
      results.push(
        records.length > before
          ? { cypher: last.cypher, params: last.params }
          : {},
      );
    } catch (err) {
      results.push({ error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, warnings };
}

function resetGlobalCaches(): void {
  Model.clearSelectionCache();
  clearResolveTargetDefCache();
}

async function bAloneVsAfterA(
  schemaA: string,
  schemaB: string,
  strict: boolean,
  ops: Array<(ogm: OGM) => Promise<unknown>>,
): Promise<{ alone: Outcome; afterA: Outcome }> {
  resetGlobalCaches();
  const alone = await runWith(schemaB, strict, ops);
  resetGlobalCaches();
  await runWith(schemaA, strict, ops);
  const afterA = await runWith(schemaB, strict, ops);
  return { alone, afterA };
}

afterAll(resetGlobalCaches);

describe('resolveTargetDef cache is per schema (S5s-2)', () => {
  const A = /* GraphQL */ `
    interface CiRes {
      id: ID!
      code: Int
    }
    type CiDoc implements CiRes @node {
      id: ID!
      code: Int
    }
    type CiOwner @node {
      id: ID!
      res: [CiRes!]! @relationship(type: "CI_HAS", direction: OUT)
    }
  `;
  const B = /* GraphQL */ `
    interface CiRes {
      id: ID!
      code: String
    }
    type CiImg implements CiRes @node {
      id: ID!
      code: String
    }
    type CiOwner @node {
      id: ID!
      res: [CiRes!]! @relationship(type: "CI_HAS", direction: OUT)
    }
  `;
  const ops: Array<(ogm: OGM) => Promise<unknown>> = [
    (ogm) =>
      ogm.model('CiOwner').find({ where: { res_SOME: { code: 'AB-1' } } }),
    (ogm) =>
      ogm.model('CiOwner').update({
        where: { id: 'o' },
        update: { res: [{ update: { node: { code: 'AB-2' } } }] },
      }),
    (ogm) =>
      ogm
        .model('CiOwner')
        .find({ select: { res: { select: { code: true } } } }),
  ];

  it.each([false, true])(
    'B after A matches B alone (strict: %s)',
    async (strict) => {
      const { alone, afterA } = await bAloneVsAfterA(A, B, strict, ops);
      expect(alone.results.map((r) => r.error)).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(afterA).toEqual(alone);
    },
  );
});

describe('Model selection cache is per schema (S5s-1)', () => {
  const A = /* GraphQL */ `
    type CsDog @node {
      id: ID!
      pals: [CsDog!]! @relationship(type: "CS_PAL", direction: OUT)
    }
    type CsCat @node {
      id: ID!
      pals: [CsDog!]! @relationship(type: "CS_PAL", direction: OUT)
    }
    union CsPet = CsDog | CsCat
    type CsOwner @node {
      id: ID!
      pets: [CsPet!]! @relationship(type: "CS_OWNS", direction: OUT)
    }
  `;
  const B = /* GraphQL */ `
    interface CsDog {
      id: ID!
      pals: [CsDogCat!]! @declareRelationship
    }
    interface CsCat {
      id: ID!
      pals: [CsDogCat!]! @declareRelationship
    }
    type CsDogCat implements CsDog & CsCat @node {
      id: ID!
      pals: [CsDogCat!]! @relationship(type: "CS_PAL", direction: OUT)
    }
    type CsOwner @node {
      id: ID!
      pets: [CsDogCat!]! @relationship(type: "CS_OWNS", direction: OUT)
    }
  `;
  const sel =
    '{ id pets { ... on CsDog { pals(where: { id: "a" }) { id } } ... on CsCat { pals(where: { id: "b" }) { id } } } }';
  const ops: Array<(ogm: OGM) => Promise<unknown>> = [
    (ogm) => ogm.model('CsOwner').find({ selectionSet: sel }),
  ];

  it.each([false, true])(
    'B after A matches B alone (strict: %s)',
    async (strict) => {
      const { alone, afterA } = await bAloneVsAfterA(A, B, strict, ops);
      if (!strict) expect(alone.warnings.join('\n')).toMatch(/pals/);
      expect(afterA).toEqual(alone);
    },
  );

  it('the same OGM still hits the cache', async () => {
    resetGlobalCaches();
    const records: Recorded[] = [];
    const ogm = new OGM({ typeDefs: B, driver: mockDriver(records) });
    const parse = jest.spyOn(
      (ogm as unknown as { modelCompilers: { selection: object } })
        .modelCompilers.selection as { parseSelectionSet: () => unknown },
      'parseSelectionSet',
    );
    await ogm.model('CsOwner').find({ selectionSet: '{ id }' });
    await ogm.model('CsOwner').find({ selectionSet: '{ id }' });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(records[0].cypher).toBe(records[1].cypher);
  });
});
