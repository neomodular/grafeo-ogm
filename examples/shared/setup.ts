import * as fs from 'node:fs';
import * as path from 'node:path';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from 'grafeo-ogm';

export const typeDefs = fs.readFileSync(
  path.join(__dirname, '..', 'schema.graphql'),
  'utf-8',
);

export function createOGM(): { ogm: OGM; driver: Driver } {
  const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER ?? 'neo4j';
  const password = process.env.NEO4J_PASSWORD ?? 'password';

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const ogm = new OGM({ typeDefs, driver });

  return { ogm, driver };
}

export async function cleanup(ogm: OGM, driver: Driver): Promise<void> {
  ogm.close();
  await driver.close();
}
