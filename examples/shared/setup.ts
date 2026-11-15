import * as fs from 'node:fs';
import * as path from 'node:path';
import neo4j, { Driver } from 'neo4j-driver';
import { OGM } from 'grafeo-ogm';
import type { InterfaceModelMap, ModelMap } from '../grafeo.generated';

export const typeDefs = fs.readFileSync(
  path.join(__dirname, '..', 'schema.graphql'),
  'utf-8',
);

/**
 * The OGM typed with the maps generated from schema.graphql
 * (`grafeo generate`): every `ogm.model('Book')` call returns a model whose
 * where / select / create / update inputs and results are typed.
 */
export type ExampleOGM = OGM<ModelMap, InterfaceModelMap>;

export function createOGM(): { ogm: ExampleOGM; driver: Driver } {
  const uri = process.env.NEO4J_URI ?? 'bolt://localhost:7687';
  const user = process.env.NEO4J_USER ?? 'neo4j';
  const password = process.env.NEO4J_PASSWORD ?? 'password';

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const ogm = new OGM<ModelMap, InterfaceModelMap>({ typeDefs, driver });

  return { ogm, driver };
}

export async function cleanup(ogm: ExampleOGM, driver: Driver): Promise<void> {
  ogm.close();
  await driver.close();
}
