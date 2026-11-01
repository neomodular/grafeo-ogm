import { OGMError } from '../errors';

/** README section listing the optional server features (APOC, GenAI, …). */
export const OPTIONAL_SERVER_FEATURES_URL =
  'https://github.com/neomodular/grafeo-ogm#does-grafeo-ogm-work-with-neo4j-aura';

interface Neo4jErrorLike {
  code?: unknown;
  message?: unknown;
}

function asNeo4jError(error: unknown): Neo4jErrorLike | undefined {
  return typeof error === 'object' && error !== null
    ? (error as Neo4jErrorLike)
    : undefined;
}

/**
 * True when `error` is Neo4j rejecting the statement because an APOC
 * function or procedure (`apoc.*`) is not installed on the server.
 *
 * Neo4j 5.x reports an unknown function as
 * `Neo.ClientError.Statement.SyntaxError` "Unknown function 'apoc.x'" and an
 * unknown procedure as `Neo.ClientError.Procedure.ProcedureNotFound`
 * "There is no procedure with the name `apoc.x` registered…". When `name`
 * is given only that function / procedure matches.
 */
export function isMissingApocError(error: unknown, name?: string): boolean {
  const e = asNeo4jError(error);
  if (!e || typeof e.message !== 'string') return false;
  const pattern = name ? name.replace(/\./g, '\\.') : 'apoc\\.[\\w.]+';
  if (e.code === 'Neo.ClientError.Statement.SyntaxError')
    return new RegExp(`^Unknown function '${pattern}'`).test(e.message);
  if (e.code === 'Neo.ClientError.Procedure.ProcedureNotFound')
    return new RegExp(
      `^There is no procedure with the name \`${pattern}\``,
    ).test(e.message);
  return false;
}

/**
 * Map a server error the OGM's own generated Cypher can cause on a server
 * without an optional plugin to a clear `OGMError` (the original stays as
 * `cause`). Any other error is returned unchanged.
 *
 * v2.26.0 — pre-v2.26.0 a nested relationship sort or a connection `sort` on a
 * server without APOC failed with Neo4j's raw
 * `Unknown function 'apoc.coll.sortMulti'`, which does not say which OGM
 * feature needs what.
 */
export function mapServerError(error: unknown): unknown {
  if (isMissingApocError(error, 'apoc.coll.sortMulti'))
    return new OGMError(
      'Sorting a relationship field or a connection (typed `orderBy` on a relationship or connection, ' +
        '`selectionSet` `options.sort` on a relationship field, connection `sort`) needs the APOC plugin ' +
        '(`apoc.coll.sortMulti`), and this Neo4j server does not have it. Install APOC on the server, or ' +
        `sort at the root instead. See the optional server features: ${OPTIONAL_SERVER_FEATURES_URL}`,
      { cause: error },
    );
  return error;
}
