/**
 * vNEXT — a statement the OGM generated that needs APOC fails on a server
 * without it with a clear OGMError (the Neo4j error as `cause`), on every
 * execution path; other errors are rethrown unchanged. The live check is
 * tests/integration/missing-apoc.spec.ts.
 */
import { Driver, Session, Transaction } from 'neo4j-driver';
import { Executor } from '../src/execution/executor';
import {
  isMissingApocError,
  mapServerError,
} from '../src/execution/server-errors';
import { OGMError, SubgraphOperationError } from '../src/errors';
import {
  cloneSubgraph,
  deleteSubgraph,
} from '../src/subgraph/subgraph-operations';

/** The error shape neo4j-driver 5 throws (Neo4j 5.26, no APOC). */
function neo4jError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, name: 'Neo4jError' });
}
const unknownSortMulti = () =>
  neo4jError(
    'Neo.ClientError.Statement.SyntaxError',
    'Unknown function \'apoc.coll.sortMulti\' (line 1, column 8 (offset: 7))\n"RETURN apoc.coll.sortMulti([], [])"\n        ^',
  );
const noSubgraphAll = () =>
  neo4jError(
    'Neo.ClientError.Procedure.ProcedureNotFound',
    "There is no procedure with the name `apoc.path.subgraphAll` registered for this database instance. Please ensure you've spelled the procedure name correctly and that the procedure is properly deployed.",
  );

function failing(err: Error) {
  return jest.fn().mockRejectedValue(err);
}

describe('Executor — missing APOC', () => {
  const paths: Array<[string, (run: jest.Mock) => Promise<unknown>]> = [
    [
      'auto-commit session',
      (run) =>
        new Executor({
          session: () => ({ run, close: jest.fn() }),
        } as unknown as Driver).execute('Q', {}),
    ],
    [
      'caller transaction',
      (run) =>
        new Executor({} as Driver).execute(
          'Q',
          {},
          { transaction: { run } as unknown as Transaction },
        ),
    ],
    [
      'caller session',
      (run) =>
        new Executor({} as Driver).execute(
          'Q',
          {},
          { session: { run } as unknown as Session },
        ),
    ],
  ];

  it.each(paths)(
    'maps apoc.coll.sortMulti to OGMError (%s)',
    async (_label, exec) => {
      const original = unknownSortMulti();
      const err = await exec(failing(original)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OGMError);
      expect((err as OGMError).message).toMatch(
        /^Sorting a relationship field or a connection .* needs the APOC plugin \(`apoc\.coll\.sortMulti`\)/,
      );
      expect((err as OGMError).message).toContain(
        'https://github.com/neomodular/grafeo-ogm#does-grafeo-ogm-work-with-neo4j-aura',
      );
      expect((err as OGMError).cause).toBe(original);
    },
  );

  it.each(paths)(
    'rethrows any other error unchanged (%s)',
    async (_l, exec) => {
      for (const original of [
        neo4jError(
          'Neo.ClientError.Statement.SyntaxError',
          "Unknown function 'foo.bar' (line 1, column 8 (offset: 7))",
        ),
        neo4jError(
          'Neo.ClientError.Statement.SyntaxError',
          "Unknown function 'apoc.coll.sortMultiX' (line 1)",
        ),
        neo4jError('Neo.ClientError.Statement.EntityNotFound', 'gone'),
        new TypeError('x'),
      ]) {
        const err = await exec(failing(original)).catch((e: unknown) => e);
        expect(err).toBe(original);
      }
    },
  );
});

describe('isMissingApocError / mapServerError', () => {
  it('matches only the Neo4j codes for an unknown apoc function / procedure', () => {
    expect(isMissingApocError(unknownSortMulti())).toBe(true);
    expect(isMissingApocError(unknownSortMulti(), 'apoc.coll.sortMulti')).toBe(
      true,
    );
    expect(isMissingApocError(unknownSortMulti(), 'apoc.coll.toSet')).toBe(
      false,
    );
    expect(isMissingApocError(noSubgraphAll())).toBe(true);
    expect(isMissingApocError(noSubgraphAll(), 'apoc.coll.sortMulti')).toBe(
      false,
    );
    // Same text, other code (e.g. a user string echoed in another error).
    expect(
      isMissingApocError(
        neo4jError('Neo.ClientError.General.X', "Unknown function 'apoc.x'"),
      ),
    ).toBe(false);
    expect(isMissingApocError(null)).toBe(false);
    expect(isMissingApocError('Unknown function')).toBe(false);
  });

  it('leaves a missing procedure to the subgraph operations', () => {
    const original = noSubgraphAll();
    expect(mapServerError(original)).toBe(original);
  });
});

describe('cloneSubgraph / deleteSubgraph — missing APOC', () => {
  const config = {
    ownedLabels: ['Book'],
    ownedRelationships: ['HAS'],
    maxLevel: 1,
    referenceRelationships: [],
  };

  it.each(['clone', 'delete'] as const)(
    '%sSubgraph says it needs APOC',
    async (op) => {
      const original = noSubgraphAll();
      const tx = { run: failing(original) } as unknown as Transaction;
      const err = await (
        op === 'clone'
          ? cloneSubgraph('r1', config, tx)
          : deleteSubgraph('r1', config, tx)
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SubgraphOperationError);
      expect((err as Error).message).toBe(
        `Subgraph ${op} failed for root=r1: ${op}Subgraph needs the APOC plugin, and this Neo4j server ` +
          'does not have it (There is no procedure with the name `apoc.path.subgraphAll` registered for ' +
          "this database instance. Please ensure you've spelled the procedure name correctly and that the " +
          'procedure is properly deployed.). Install APOC on the server. See the optional server features: ' +
          'https://github.com/neomodular/grafeo-ogm#does-grafeo-ogm-work-with-neo4j-aura',
      );
      expect((err as SubgraphOperationError).cause).toBe(original);
    },
  );

  it('keeps any other error message', async () => {
    const original = neo4jError('Neo.ClientError.X', 'boom');
    const tx = { run: failing(original) } as unknown as Transaction;
    const err = await deleteSubgraph('r1', config, tx).catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      'Subgraph delete failed for root=r1: boom',
    );
  });
});
