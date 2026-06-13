import neo4j, { type Driver } from 'neo4j-driver';
import type { CliIO, ResolvedConnection } from './types';

/**
 * Obtain the driver for a db command. Production goes straight to
 * `neo4j-driver`; tests inject a mock through `io.driverFactory` so no
 * command ever touches a real database in the suite.
 *
 * Imported only by `db push` / `db seed` (themselves lazy-loaded from the
 * router), so `grafeo generate` never pays the neo4j-driver load.
 */
export function createDriver(
  io: CliIO,
  connection: ResolvedConnection,
): Driver {
  if (io.driverFactory) return io.driverFactory(connection);
  return neo4j.driver(
    connection.uri,
    neo4j.auth.basic(connection.username, connection.password),
  );
}
