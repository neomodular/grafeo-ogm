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
  const item: LiveSchemaItem = {
    name,
    type: typeof type === 'string' ? type : String(type ?? ''),
  };
  // The definition columns let the planner attribute a constraint by what
  // it constrains, not just its name. Absent on a server → left undefined,
  // and the planner then never treats the row as droppable.
  const labels = stringList(record, 'labelsOrTypes');
  const props = stringList(record, 'properties');
  if (labels) item.labelsOrTypes = labels;
  if (props) item.properties = props;
  return item;
}

function stringList(
  record: { get(key: string): unknown },
  key: string,
): string[] | undefined {
  let value: unknown;
  try {
    value = record.get(key);
  } catch {
    return undefined;
  }
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : undefined;
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
