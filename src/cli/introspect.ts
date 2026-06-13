import type { Driver } from 'neo4j-driver';
import type { LiveSchema, LiveSchemaItem } from './push-planner';

/**
 * Normalize one SHOW CONSTRAINTS / SHOW INDEXES record. Both commands
 * expose `name` and `type` columns across the Neo4j 5.x line, but column
 * sets vary by minor version and the driver throws on unknown keys — so
 * every access is guarded and non-conforming rows are dropped rather than
 * crashing the push.
 */
function toLiveItem(record: {
  get(key: string): unknown;
}): LiveSchemaItem | null {
  let name: unknown;
  let type: unknown;
  try {
    name = record.get('name');
  } catch {
    return null;
  }
  try {
    type = record.get('type');
  } catch {
    type = '';
  }

  if (typeof name !== 'string' || name.length === 0) return null;
  return { name, type: typeof type === 'string' ? type : String(type ?? '') };
}

/**
 * Fetch the live constraint/index state for the push planner. Read-only —
 * runs exactly `SHOW CONSTRAINTS` and `SHOW INDEXES`.
 */
export async function fetchLiveSchema(
  driver: Driver,
  database?: string,
): Promise<LiveSchema> {
  const session = driver.session(database ? { database } : undefined);
  try {
    const constraintsResult = await session.run('SHOW CONSTRAINTS');
    const indexesResult = await session.run('SHOW INDEXES');
    return {
      constraints: constraintsResult.records
        .map(toLiveItem)
        .filter((i): i is LiveSchemaItem => i !== null),
      indexes: indexesResult.records
        .map(toLiveItem)
        .filter((i): i is LiveSchemaItem => i !== null),
    };
  } finally {
    await session.close();
  }
}
