import { Transaction } from 'neo4j-driver';
import {
  cloneSubgraph,
  deleteSubgraph,
} from '../src/subgraph/subgraph-operations';
import { SubgraphOperationError } from '../src/errors';
import { SubgraphConfig } from '../src/subgraph/types';

// --- Mock helpers -----------------------------------------------------------

function createMockTransaction(
  runResults: Array<{ records: Array<{ get: (key: string) => unknown }> }> = [],
): Transaction {
  let callIndex = 0;
  return {
    run: jest.fn().mockImplementation(() => {
      const result = runResults[callIndex] ?? { records: [] };
      callIndex++;
      return Promise.resolve(result);
    }),
  } as unknown as Transaction;
}

function mockRecord(data: Record<string, unknown>) {
  return { get: (key: string) => data[key] };
}

// --- Tests ------------------------------------------------------------------

describe('SubgraphOperationError', () => {
  it('should construct with all properties', () => {
    const cause = new Error('APOC not available');
    const err = new SubgraphOperationError(
      'clone',
      'root-123',
      'something broke',
      cause,
    );

    expect(err).toBeInstanceOf(SubgraphOperationError);
    expect(err.name).toBe('SubgraphOperationError');
    expect(err.operation).toBe('clone');
    expect(err.rootId).toBe('root-123');
    expect(err.cause).toBe(cause);
    expect(err.message).toContain('clone');
    expect(err.message).toContain('root-123');
    expect(err.message).toContain('something broke');
  });

  it('should construct without cause', () => {
    const err = new SubgraphOperationError('delete', 'root-456', 'not found');

    expect(err.cause).toBeUndefined();
    expect(err.operation).toBe('delete');
    expect(err.rootId).toBe('root-456');
  });

  it('should extend Error', () => {
    const err = new SubgraphOperationError('clone', '', 'test');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('cloneSubgraph', () => {
  const baseConfig: SubgraphConfig = {
    ownedLabels: ['Post', 'Comment'],
    ownedRelationships: ['HAS_COMMENT'],
    maxLevel: 5,
    referenceRelationships: [],
  };

  // v1.8.7 — same guard as deleteSubgraph: empty filters would clone the
  // entire connected component instead of a scoped subgraph.
  it('rejects empty ownedLabels and ownedRelationships (v1.8.7)', async () => {
    const tx = createMockTransaction();
    await expect(
      cloneSubgraph('root-1', { ...baseConfig, ownedLabels: [] }, tx),
    ).rejects.toThrow(/ownedLabels must not be empty/);
    await expect(
      cloneSubgraph('root-1', { ...baseConfig, ownedRelationships: [] }, tx),
    ).rejects.toThrow(/ownedRelationships must not be empty/);
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('should clone a basic subgraph and return mapping', async () => {
    const tx = createMockTransaction([
      // Step 1: APOC clone result
      {
        records: [
          mockRecord({ originalId: 'root-1', cloneElementId: 'elem-1' }),
          mockRecord({ originalId: 'child-1', cloneElementId: 'elem-2' }),
        ],
      },
      // Step 2: UUID generation
      {
        records: [
          mockRecord({ elemId: 'elem-1', newId: 'new-uuid-1' }),
          mockRecord({ elemId: 'elem-2', newId: 'new-uuid-2' }),
        ],
      },
    ]);

    const result = await cloneSubgraph('root-1', baseConfig, tx);

    expect(result.clonedRootId).toBe('new-uuid-1');
    expect(result.nodeMapping.size).toBe(2);
    expect(result.nodeMapping.get('root-1')).toBe('new-uuid-1');
    expect(result.nodeMapping.get('child-1')).toBe('new-uuid-2');
    // records without a `labels` entry yield an empty (but present) map
    expect(result.nodesByLabel.size).toBe(0);
    expect(tx.run).toHaveBeenCalledTimes(2);
  });

  it('groups cloned nodes by label (v1.13.0 nodesByLabel)', async () => {
    const tx = createMockTransaction([
      {
        records: [
          mockRecord({
            originalId: 'root-1',
            cloneElementId: 'elem-1',
            labels: ['Post'],
          }),
          mockRecord({
            originalId: 'child-1',
            cloneElementId: 'elem-2',
            labels: ['Comment'],
          }),
          mockRecord({
            originalId: 'child-2',
            cloneElementId: 'elem-3',
            labels: ['Comment'],
          }),
        ],
      },
      {
        records: [
          mockRecord({ elemId: 'elem-1', newId: 'new-uuid-1' }),
          mockRecord({ elemId: 'elem-2', newId: 'new-uuid-2' }),
          mockRecord({ elemId: 'elem-3', newId: 'new-uuid-3' }),
        ],
      },
    ]);

    const result = await cloneSubgraph('root-1', baseConfig, tx);

    const firstQuery = (tx.run as jest.Mock).mock.calls[0][0] as string;
    expect(firstQuery).toContain('labels(output) AS labels');
    expect(result.nodesByLabel.get('Post')).toEqual(['new-uuid-1']);
    expect(result.nodesByLabel.get('Comment')).toEqual([
      'new-uuid-2',
      'new-uuid-3',
    ]);
  });

  it('maps the root node label to clonedRootId', async () => {
    const tx = createMockTransaction([
      {
        records: [
          mockRecord({
            originalId: 'root-1',
            cloneElementId: 'elem-1',
            labels: ['Post'],
          }),
          mockRecord({
            originalId: 'child-1',
            cloneElementId: 'elem-2',
            labels: ['Comment'],
          }),
        ],
      },
      {
        records: [
          mockRecord({ elemId: 'elem-1', newId: 'new-uuid-1' }),
          mockRecord({ elemId: 'elem-2', newId: 'new-uuid-2' }),
        ],
      },
    ]);

    const result = await cloneSubgraph('root-1', baseConfig, tx);

    expect(result.nodesByLabel.get('Post')).toContain(result.clonedRootId);
  });

  it('lists a multi-label node under each of its labels', async () => {
    const tx = createMockTransaction([
      {
        records: [
          mockRecord({
            originalId: 'root-1',
            cloneElementId: 'elem-1',
            labels: ['Post', 'Draft'],
          }),
        ],
      },
      {
        records: [mockRecord({ elemId: 'elem-1', newId: 'new-uuid-1' })],
      },
    ]);

    const result = await cloneSubgraph('root-1', baseConfig, tx);

    expect(result.nodesByLabel.get('Post')).toEqual(['new-uuid-1']);
    expect(result.nodesByLabel.get('Draft')).toEqual(['new-uuid-1']);
  });

  it('omits UUID-assignment failures from nodeMapping and nodesByLabel alike', async () => {
    const tx = createMockTransaction([
      {
        records: [
          mockRecord({
            originalId: 'root-1',
            cloneElementId: 'elem-1',
            labels: ['Post'],
          }),
          mockRecord({
            originalId: 'child-1',
            cloneElementId: 'elem-2',
            labels: ['Comment'],
          }),
        ],
      },
      // UUID generation only returns the root — child-1's assignment failed
      {
        records: [mockRecord({ elemId: 'elem-1', newId: 'new-uuid-1' })],
      },
    ]);

    const result = await cloneSubgraph('root-1', baseConfig, tx);

    expect(result.nodeMapping.size).toBe(1);
    expect(result.nodeMapping.has('child-1')).toBe(false);
    expect(result.nodesByLabel.has('Comment')).toBe(false);
    // every id in nodesByLabel must also be a nodeMapping value
    const mappedIds = new Set(result.nodeMapping.values());
    for (const ids of result.nodesByLabel.values())
      for (const id of ids) expect(mappedIds.has(id)).toBe(true);
  });

  it('should reattach reference relationships', async () => {
    const configWithRefs: SubgraphConfig = {
      ...baseConfig,
      referenceRelationships: [
        { fromLabel: 'Post', relationshipType: 'HAS_TAG', direction: 'OUT' },
      ],
    };

    const tx = createMockTransaction([
      // APOC clone
      {
        records: [
          mockRecord({ originalId: 'root-1', cloneElementId: 'elem-1' }),
        ],
      },
      // UUID generation
      {
        records: [mockRecord({ elemId: 'elem-1', newId: 'new-uuid-1' })],
      },
      // Reattach reference relationships
      {
        records: [mockRecord({ totalCreated: 2 })],
      },
    ]);

    const result = await cloneSubgraph('root-1', configWithRefs, tx);

    expect(result.clonedRootId).toBe('new-uuid-1');
    // 3 calls: APOC clone, UUID gen, reattach
    expect(tx.run).toHaveBeenCalledTimes(3);
  });

  it('should respect maxLevel in APOC calls', async () => {
    const config: SubgraphConfig = {
      ...baseConfig,
      maxLevel: 3,
    };

    const tx = createMockTransaction([
      {
        records: [
          mockRecord({ originalId: 'root-1', cloneElementId: 'elem-1' }),
        ],
      },
      {
        records: [mockRecord({ elemId: 'elem-1', newId: 'new-uuid-1' })],
      },
    ]);

    await cloneSubgraph('root-1', config, tx);

    const firstCall = (tx.run as jest.Mock).mock.calls[0];
    expect(firstCall[1].maxLevel).toBe(3);
  });

  it('should throw SubgraphOperationError when APOC fails', async () => {
    const tx = {
      run: jest.fn().mockRejectedValue(new Error('APOC procedure not found')),
    } as unknown as Transaction;

    await expect(cloneSubgraph('root-1', baseConfig, tx)).rejects.toThrow(
      SubgraphOperationError,
    );

    try {
      await cloneSubgraph('root-1', baseConfig, tx);
    } catch (err) {
      const sErr = err as SubgraphOperationError;
      expect(sErr.operation).toBe('clone');
      expect(sErr.rootId).toBe('root-1');
      expect(sErr.cause).toBeInstanceOf(Error);
    }
  });

  it('should throw when clone produces no root node', async () => {
    const tx = createMockTransaction([
      // APOC clone returns empty result
      { records: [] },
    ]);

    await expect(cloneSubgraph('root-1', baseConfig, tx)).rejects.toThrow(
      /Clone did not produce a root node/,
    );
  });

  it('should validate config and reject unsafe labels', async () => {
    const badConfig: SubgraphConfig = {
      ownedLabels: ['Post; DROP DATABASE'],
      ownedRelationships: ['HAS_COMMENT'],
      maxLevel: 5,
      referenceRelationships: [],
    };

    const tx = createMockTransaction([]);

    await expect(cloneSubgraph('root-1', badConfig, tx)).rejects.toThrow();
  });

  it('should validate config and reject invalid reference direction', async () => {
    const badConfig: SubgraphConfig = {
      ownedLabels: ['Post'],
      ownedRelationships: ['HAS_COMMENT'],
      maxLevel: 5,
      referenceRelationships: [
        {
          fromLabel: 'Post',
          relationshipType: 'HAS_TAG',
          direction: 'BOTH' as 'OUT',
        },
      ],
    };

    const tx = createMockTransaction([]);

    await expect(cloneSubgraph('root-1', badConfig, tx)).rejects.toThrow(
      /Invalid direction/,
    );
  });

  it('should validate config and reject unsafe relationship types', async () => {
    const badConfig: SubgraphConfig = {
      ownedLabels: ['Post'],
      ownedRelationships: ['DROP INDEX'],
      maxLevel: 5,
      referenceRelationships: [],
    };

    const tx = createMockTransaction([]);

    await expect(cloneSubgraph('root-1', badConfig, tx)).rejects.toThrow();
  });

  it('should skip reattach phase when no reference relationships configured', async () => {
    const tx = createMockTransaction([
      {
        records: [
          mockRecord({ originalId: 'root-1', cloneElementId: 'elem-1' }),
        ],
      },
      {
        records: [mockRecord({ elemId: 'elem-1', newId: 'new-uuid-1' })],
      },
    ]);

    await cloneSubgraph('root-1', baseConfig, tx);

    // Only 2 calls: APOC clone + UUID gen (no reattach)
    expect(tx.run).toHaveBeenCalledTimes(2);
  });
});

describe('deleteSubgraph', () => {
  const baseConfig: SubgraphConfig = {
    ownedLabels: ['Post', 'Comment'],
    ownedRelationships: ['HAS_COMMENT'],
    maxLevel: 5,
    referenceRelationships: [],
  };

  it('should delete subgraph and return count', async () => {
    const tx = createMockTransaction([
      {
        records: [mockRecord({ deletedCount: { toNumber: () => 5 } })],
      },
    ]);

    const result = await deleteSubgraph('root-1', baseConfig, tx);

    expect(result.deletedCount).toBe(5);
    expect(tx.run).toHaveBeenCalledTimes(1);
  });

  // v1.8.7 — empty filter arrays are treated by apoc.path.subgraphAll
  // as "no constraint", so pre-1.8.7 an empty ownedLabels/
  // ownedRelationships expanded the DETACH DELETE to the ENTIRE
  // connected component reachable from the root. The guard must fire
  // BEFORE any Cypher runs.
  it('rejects empty ownedLabels before running any Cypher (v1.8.7)', async () => {
    const tx = createMockTransaction();
    await expect(
      deleteSubgraph('root-1', { ...baseConfig, ownedLabels: [] }, tx),
    ).rejects.toThrow(/ownedLabels must not be empty/);
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('rejects empty ownedRelationships before running any Cypher (v1.8.7)', async () => {
    const tx = createMockTransaction();
    await expect(
      deleteSubgraph('root-1', { ...baseConfig, ownedRelationships: [] }, tx),
    ).rejects.toThrow(/ownedRelationships must not be empty/);
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('validation errors carry operation "delete" and the real rootId (v1.8.7)', async () => {
    // Pre-1.8.7 validateConfig hardcoded operation 'clone' and an empty
    // rootId, so delete-path failures surfaced as clone errors.
    const tx = createMockTransaction();
    const badDirection: SubgraphConfig = {
      ...baseConfig,
      referenceRelationships: [
        {
          fromLabel: 'Post',
          relationshipType: 'HAS_TAG',
          direction: 'SIDEWAYS' as 'OUT',
        },
      ],
    };

    let caught: unknown;
    try {
      await deleteSubgraph('root-9', badDirection, tx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SubgraphOperationError);
    expect((caught as SubgraphOperationError).operation).toBe('delete');
    expect((caught as SubgraphOperationError).rootId).toBe('root-9');
  });

  it('should pass correct params to the cypher query', async () => {
    const tx = createMockTransaction([
      {
        records: [mockRecord({ deletedCount: 0 })],
      },
    ]);

    await deleteSubgraph('root-1', baseConfig, tx);

    const callArgs = (tx.run as jest.Mock).mock.calls[0][1];
    expect(callArgs.rootId).toBe('root-1');
    expect(callArgs.relFilter).toBe('HAS_COMMENT');
    expect(callArgs.labelFilter).toBe('+Post|+Comment');
    expect(callArgs.maxLevel).toBe(5);
  });

  it('should handle deletedCount as plain number', async () => {
    const tx = createMockTransaction([
      {
        records: [mockRecord({ deletedCount: 3 })],
      },
    ]);

    const result = await deleteSubgraph('root-1', baseConfig, tx);
    expect(result.deletedCount).toBe(3);
  });

  it('should return 0 when no records returned', async () => {
    const tx = createMockTransaction([{ records: [] }]);

    const result = await deleteSubgraph('root-1', baseConfig, tx);
    expect(result.deletedCount).toBe(0);
  });

  it('should throw SubgraphOperationError when query fails', async () => {
    const tx = {
      run: jest.fn().mockRejectedValue(new Error('Connection lost')),
    } as unknown as Transaction;

    await expect(deleteSubgraph('root-1', baseConfig, tx)).rejects.toThrow(
      SubgraphOperationError,
    );

    try {
      await deleteSubgraph('root-1', baseConfig, tx);
    } catch (err) {
      const sErr = err as SubgraphOperationError;
      expect(sErr.operation).toBe('delete');
      expect(sErr.rootId).toBe('root-1');
    }
  });

  it('should validate config and reject unsafe labels', async () => {
    const badConfig: SubgraphConfig = {
      ownedLabels: ['Post; MATCH (n) DELETE n'],
      ownedRelationships: ['HAS_COMMENT'],
      maxLevel: 5,
      referenceRelationships: [],
    };

    const tx = createMockTransaction([]);

    await expect(deleteSubgraph('root-1', badConfig, tx)).rejects.toThrow();
  });

  it('should build labelFilter with + prefix for each label', async () => {
    const config: SubgraphConfig = {
      ownedLabels: ['Post', 'Comment', 'Reply'],
      ownedRelationships: ['HAS_COMMENT', 'HAS_REPLY'],
      maxLevel: 10,
      referenceRelationships: [],
    };

    const tx = createMockTransaction([
      { records: [mockRecord({ deletedCount: 0 })] },
    ]);

    await deleteSubgraph('root-1', config, tx);

    const callArgs = (tx.run as jest.Mock).mock.calls[0][1];
    expect(callArgs.relFilter).toBe('HAS_COMMENT|HAS_REPLY');
    expect(callArgs.labelFilter).toBe('+Post|+Comment|+Reply');
  });
});
