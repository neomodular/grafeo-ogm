import { Transaction } from 'neo4j-driver';
import { SubgraphOperationError } from '../errors';
import { OGMLogger } from '../execution/executor';
import {
  assertSafeIdentifier,
  assertSafeLabel,
  escapeIdentifier,
} from '../utils/validation';
import {
  SubgraphCloneResult,
  SubgraphConfig,
  SubgraphDeleteResult,
} from './types';

/** No-op logger used when no logger is provided. */
const NOOP_LOGGER: OGMLogger = { debug: () => {} };

/**
 * Validates all labels and relationship types in a SubgraphConfig
 * to prevent Cypher injection (these values are string-interpolated).
 */
function validateConfig(config: SubgraphConfig): void {
  for (const label of config.ownedLabels) assertSafeLabel(label);

  for (const rel of config.ownedRelationships)
    assertSafeIdentifier(rel, 'owned relationship type');

  for (const ref of config.referenceRelationships) {
    assertSafeLabel(ref.fromLabel);
    assertSafeIdentifier(ref.relationshipType, 'reference relationship type');

    if (ref.direction !== 'OUT' && ref.direction !== 'IN')
      throw new SubgraphOperationError(
        'clone',
        '',
        `Invalid direction "${ref.direction}" for reference relationship ${ref.relationshipType}`,
      );
  }
}

/**
 * Clones a content subgraph rooted at the given source node using APOC procedures.
 *
 * Phase 1: Collects the subgraph via `apoc.path.subgraphAll` and clones it
 *          with `apoc.refactor.cloneSubgraph`. Generates new UUIDs for all cloned nodes
 *          and sets `clonedFromId` on each clone pointing to the original.
 *
 * Phase 2: Re-attaches reference relationships from cloned nodes to shared/lookup nodes
 *          (e.g., Language, Status, MeasurementUnit) that were outside the clone scope.
 *
 * @param sourceRootId - The `id` property of the root node to clone
 * @param config - Defines which nodes to clone vs reference
 * @param transaction - Caller-managed Neo4j transaction
 * @param logger - Optional logger for debug output
 * @returns The cloned root node id and a mapping of original→cloned node ids
 */
export async function cloneSubgraph(
  sourceRootId: string,
  config: SubgraphConfig,
  transaction: Transaction,
  logger?: OGMLogger,
): Promise<SubgraphCloneResult> {
  const log = logger ?? NOOP_LOGGER;
  validateConfig(config);

  try {
    const cloneResult = await executeApocClone(
      sourceRootId,
      config,
      transaction,
      log,
    );

    log.debug(
      '[OGM $cloneSubgraph] Cloned %d nodes from root %s',
      cloneResult.nodeMapping.size,
      sourceRootId,
    );

    await reattachReferenceRelationships(config, cloneResult, transaction, log);

    return cloneResult;
  } catch (error) {
    if (error instanceof SubgraphOperationError) throw error;

    throw new SubgraphOperationError(
      'clone',
      sourceRootId,
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Deletes a content subgraph rooted at the given node using APOC procedures.
 *
 * Uses `apoc.path.subgraphAll` to collect all owned nodes within the configured
 * labels and relationships, then `DETACH DELETE`s them.
 *
 * @param rootId - The `id` property of the subgraph root node to delete
 * @param config - Defines which labels/relationships form the owned subgraph
 * @param transaction - Caller-managed Neo4j transaction
 * @param logger - Optional logger for debug output
 * @returns The count of deleted nodes
 */
export async function deleteSubgraph(
  rootId: string,
  config: SubgraphConfig,
  transaction: Transaction,
  logger?: OGMLogger,
): Promise<SubgraphDeleteResult> {
  const log = logger ?? NOOP_LOGGER;
  validateConfig(config);

  const relFilter = config.ownedRelationships.join('|');
  const labelFilter = config.ownedLabels.map((l) => `+${l}`).join('|');

  try {
    const result = await transaction.run(
      `
      MATCH (source {id: $rootId})
      CALL apoc.path.subgraphAll(source, {
        relationshipFilter: $relFilter,
        labelFilter: $labelFilter,
        maxLevel: $maxLevel
      }) YIELD nodes
      UNWIND nodes AS n
      DETACH DELETE n
      RETURN count(*) AS deletedCount
      `,
      {
        rootId,
        relFilter,
        labelFilter,
        maxLevel: config.maxLevel,
      },
    );

    const deletedCount =
      result.records[0]?.get('deletedCount')?.toNumber?.() ??
      result.records[0]?.get('deletedCount') ??
      0;

    log.debug(
      '[OGM $deleteSubgraph] Deleted %d nodes from root %s',
      deletedCount,
      rootId,
    );

    return { deletedCount };
  } catch (error) {
    if (error instanceof SubgraphOperationError) throw error;

    throw new SubgraphOperationError(
      'delete',
      rootId,
      error instanceof Error ? error.message : String(error),
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Executes the APOC subgraph clone and generates new UUIDs for cloned nodes.
 */
async function executeApocClone(
  sourceRootId: string,
  config: SubgraphConfig,
  transaction: Transaction,
  logger: OGMLogger,
): Promise<SubgraphCloneResult> {
  const relFilter = config.ownedRelationships.join('|');
  const labelFilter = config.ownedLabels.map((l) => `+${l}`).join('|');

  // Step 1: Collect subgraph and clone it
  // APOC cloneSubgraph returns: input=INTEGER (original internal ID), output=NODE (clone).
  // skipProperties: ['id'] avoids unique constraint violations during clone.
  // We use `input` (internal ID) to match back to the original's app-level id.
  const result = await transaction.run(
    `
    MATCH (source {id: $sourceId})
    CALL apoc.path.subgraphAll(source, {
      relationshipFilter: $relFilter,
      labelFilter: $labelFilter,
      maxLevel: $maxLevel
    }) YIELD nodes, relationships
    CALL apoc.refactor.cloneSubgraph(nodes, relationships, {skipProperties: ['id']})
    YIELD input, output, error
    WHERE output IS NOT NULL
    WITH input, output
    MATCH (original) WHERE id(original) = input
    SET output.clonedFromId = original.id
    RETURN original.id AS originalId, elementId(output) AS cloneElementId
    `,
    {
      sourceId: sourceRootId,
      relFilter,
      labelFilter,
      maxLevel: config.maxLevel,
    },
  );

  // Build nodeMapping from result records
  const nodeMapping = new Map<string, string>();
  let clonedRootElementId: string | undefined;

  for (const record of result.records) {
    const originalId = record.get('originalId') as string;
    const cloneElementId = record.get('cloneElementId') as string;

    nodeMapping.set(originalId, cloneElementId);

    if (originalId === sourceRootId) clonedRootElementId = cloneElementId;
  }

  if (!clonedRootElementId)
    throw new SubgraphOperationError(
      'clone',
      sourceRootId,
      'Clone did not produce a root node',
    );

  // Step 2: Generate new UUIDs for cloned nodes
  // clonedFromId was already set in Step 1 via the APOC clone query
  const uuidResult = await transaction.run(
    `
    UNWIND $elementIds AS elemId
    MATCH (n) WHERE elementId(n) = elemId
    WITH n, elementId(n) AS elemId, randomUUID() AS newId
    SET n.id = newId
    RETURN elemId, newId
    `,
    {
      elementIds: Array.from(nodeMapping.values()),
    },
  );

  // Rebuild mapping with new UUIDs: originalId → newUUID
  const elementIdToNewUuid = new Map<string, string>();
  for (const record of uuidResult.records)
    elementIdToNewUuid.set(record.get('elemId'), record.get('newId'));

  const finalMapping = new Map<string, string>();
  for (const [originalId, elementId] of nodeMapping) {
    const newUuid = elementIdToNewUuid.get(elementId);
    if (newUuid) finalMapping.set(originalId, newUuid);
  }

  const finalClonedRootId = elementIdToNewUuid.get(clonedRootElementId);
  if (!finalClonedRootId)
    throw new SubgraphOperationError(
      'clone',
      sourceRootId,
      'Failed to assign new UUID to cloned root node',
    );

  logger.debug(
    '[OGM $cloneSubgraph] APOC clone complete: %d nodes, root %s → %s',
    finalMapping.size,
    sourceRootId,
    finalClonedRootId,
  );

  return {
    clonedRootId: finalClonedRootId,
    nodeMapping: finalMapping,
  };
}

/**
 * Re-attaches reference relationships from cloned nodes to shared/lookup nodes.
 *
 * After APOC cloning, cloned nodes lose their relationships to shared nodes
 * (e.g., Language, Status, MeasurementUnit) because those were outside the clone scope.
 * This queries the original nodes for their reference relationships and re-creates
 * them on the cloned nodes.
 *
 * NOTE: `properties(r)` is materialized into a map variable (`relProps`) BEFORE
 * the CREATE to ensure relationship properties are preserved. Accessing
 * `properties(r)` after a WITH boundary inside CALL {} can silently return
 * an empty map in some Neo4j versions.
 */
async function reattachReferenceRelationships(
  config: SubgraphConfig,
  cloneResult: SubgraphCloneResult,
  transaction: Transaction,
  logger: OGMLogger,
): Promise<void> {
  if (!config.referenceRelationships.length) return;

  const mappings = Array.from(cloneResult.nodeMapping.entries()).map(
    ([originalId, cloneId]) => ({ originalId, cloneId }),
  );

  for (const refRel of config.referenceRelationships) {
    const escapedRelType = escapeIdentifier(refRel.relationshipType);
    const escapedLabel = assertSafeLabel(refRel.fromLabel);
    const matchPattern =
      refRel.direction === 'OUT'
        ? `-[r:${escapedRelType}]->(target)`
        : `<-[r:${escapedRelType}]-(target)`;
    const createPattern =
      refRel.direction === 'OUT'
        ? `CREATE (clone)-[newR:${escapedRelType}]->(target)`
        : `CREATE (clone)<-[newR:${escapedRelType}]-(target)`;

    const result = await transaction.run(
      `
      UNWIND $mappings AS mapping
      MATCH (original {id: mapping.originalId})
      WHERE original:${escapedLabel}
      MATCH (clone {id: mapping.cloneId})
      WHERE clone:${escapedLabel}
      WITH original, clone
      CALL {
        WITH original, clone
        MATCH (original)${matchPattern}
        WITH clone, target, properties(r) AS relProps
        ${createPattern}
        SET newR = relProps
        RETURN count(*) AS created
      }
      RETURN sum(created) AS totalCreated
      `,
      { mappings },
    );

    const totalCreated =
      result.records[0]?.get('totalCreated')?.toNumber?.() ??
      result.records[0]?.get('totalCreated') ??
      0;

    if (totalCreated > 0)
      logger.debug(
        '[OGM $cloneSubgraph] Reattached %d %s relationships (%s)',
        totalCreated,
        refRel.relationshipType,
        refRel.fromLabel,
      );
  }

  logger.debug(
    '[OGM $cloneSubgraph] Reattached %d reference relationship types',
    config.referenceRelationships.length,
  );
}
