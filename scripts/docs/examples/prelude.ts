// Shared setup for the README / llms-full.txt examples. A block that uses one
// of these names without declaring it gets it imported from here.
import fs from 'fs';
import neo4j, { type Transaction } from 'neo4j-driver';
import {
  OGM,
  permissive,
  type OGMLogger,
  type PoliciesByModel,
  type PolicyContext,
  type SubgraphConfig,
} from 'grafeo-ogm';
import type { ModelMap, InterfaceModelMap } from './grafeo.generated';

export {
  CypherAssert,
  Neo4jRecordFactory,
  SelectionSetFactory,
} from 'grafeo-ogm/testing';
export { OGM };

export * from './grafeo.generated';

export const driver = neo4j.driver(
  'neo4j://localhost:7687',
  neo4j.auth.basic('neo4j', 'password'),
);
export const typeDefs = fs.readFileSync('./schema.graphql', 'utf-8');
export const logger: OGMLogger = console;

export const policies: PoliciesByModel<ModelMap> = {
  Book: [
    permissive({
      operations: ['read'],
      when: (c) => ({ ownerId: c.userId }),
      name: 'owner-can-read',
    }),
  ],
};

export const ogm = new OGM<ModelMap, InterfaceModelMap>({ typeDefs, driver });

// Model handles. The books schema uses PascalCase handles (`Book.find`); the
// "Strict mode" items use camelCase plurals (`users.update`).
export const Book = ogm.model('Book');
export const Author = ogm.model('Author');
export const Category = ogm.model('Category');
export const Publisher = ogm.model('Publisher');
export const User = ogm.model('User');
export const books = Book;
export const authors = Author;
export const users = User;
export const posts = ogm.model('Post');
export const plans = ogm.model('Plan');
export const charts = ogm.model('Chart');
export const feeds = ogm.model('Feed');
export const people = ogm.model('Person');
export const tasks = ogm.model('Task');
export const events = ogm.model('Event');

// Values a request handler or test would already hold.
export declare const ctx: PolicyContext;
export declare const transaction: Transaction;
export declare const config: SubgraphConfig;
export declare const id: string;
export declare const ids: string[];
export declare const email: string;
export declare const petId: string;
export declare const postId: string;
export declare const teamId: string;
// A statement under test (README "CypherAssert").
export declare const cypher: string;
export declare const params: Record<string, unknown>;
export declare const myEmbedder: { embed(text: string): Promise<number[]> };
