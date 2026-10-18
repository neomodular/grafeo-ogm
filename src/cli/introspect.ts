import { isInt, type Driver } from 'neo4j-driver';
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
  // v2.4.8 — SHOW INDEXES only: the constraint a backing index belongs to.
  const owner = optionalGet(record, 'owningConstraint');
  if (typeof owner === 'string' && owner.length > 0)
    item.owningConstraint = owner;
  // v2.4.8 — definition detail for the planner's "changed" check.
  const entityType = optionalGet(record, 'entityType');
  if (typeof entityType === 'string') item.entityType = entityType;
  const indexConfig = readIndexConfig(optionalGet(record, 'options'));
  if (indexConfig) item.indexConfig = indexConfig;
  return item;
}

/** `record.get(key)`, or undefined when the server has no such column. */
function optionalGet(
  record: { get(key: string): unknown },
  key: string,
): unknown {
  try {
    return record.get(key);
  } catch {
    return undefined;
  }
}

/**
 * `options.indexConfig` as a plain object, with neo4j `Integer` / bigint
 * values converted to numbers so the planner can compare dimensions.
 */
function readIndexConfig(
  options: unknown,
): Record<string, unknown> | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const config = (options as { indexConfig?: unknown }).indexConfig;
  if (!config || typeof config !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as object))
    out[key] = isInt(value)
      ? value.toNumber()
      : typeof value === 'bigint'
        ? Number(value)
        : value;
  return out;
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
 * runs exactly `SHOW CONSTRAINTS` and `SHOW INDEXES YIELD *`.
 */
export async function fetchLiveSchema(
  driver: Driver,
  database?: string,
): Promise<LiveSchema> {
  const session = driver.session(database ? { database } : undefined);
  try {
    const constraintsResult = await session.run('SHOW CONSTRAINTS');
    // `YIELD *` (v2.4.8): the default SHOW INDEXES columns omit `options`,
    // which carries the vector dimensions / similarity the planner compares.
    const indexesResult = await session.run('SHOW INDEXES YIELD *');
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
