/**
 * Shared setup for the live regression specs of property-suite findings
 * (v2.6.2): the property suites' schema and seed graph under one `runId`
 * (removed in afterAll), a default OGM whose warnings are captured, and a
 * `strict: true` OGM. Call `useItpFixture()` at the top of a `describeLive`.
 */
import type { Driver, Transaction } from 'neo4j-driver';
import { OGM } from '../../../src/ogm';
import { cleanup, makeDriver, newRunId, seedGraph } from './harness';
import { typeDefs } from './schema';

export type Rec = Record<string, unknown>;

/** The model surface the specs call, with untyped (generated-shape) input. */
export interface AnyModel {
  find(p: Rec): Promise<Rec[]>;
  count(p: Rec): Promise<number>;
  aggregate(p: Rec): Promise<Rec>;
  update(p: Rec): Promise<Rec & { info: Rec }>;
  delete(p: Rec): Promise<{ nodesDeleted: number }>;
}

export interface ItpFixture {
  readonly runId: string;
  readonly driver: Driver;
  readonly ogm: OGM;
  readonly strictOgm: OGM;
  /** Warnings the default OGM logged (construction included). */
  readonly warnings: string[];
  /** `'c1'` → this run's node id. */
  id(suffix: string): string;
  /** This run's node id → `'c1'`. */
  short(id: unknown): string;
  model(name: string, ogm?: Pick<OGM, 'model'>): AnyModel;
  /** First column of `cypher` (`$runId` bound), shortened and sorted. */
  ids(tx: Transaction, cypher: string): Promise<string[]>;
}

export function useItpFixture(): ItpFixture {
  const runId = newRunId();
  let driver: Driver;
  let ogm: OGM;
  let strictOgm: OGM;
  const warnings: string[] = [];

  beforeAll(async () => {
    driver = makeDriver();
    await driver.verifyConnectivity();
    await seedGraph(driver, runId);
    ogm = new OGM({
      typeDefs,
      driver,
      logger: { debug: () => {}, warn: (msg: string) => warnings.push(msg) },
    });
    strictOgm = new OGM({ typeDefs, driver, strict: true });
  });

  afterAll(async () => {
    if (driver) {
      await cleanup(driver, runId);
      await driver.close();
    }
  });

  const short = (v: unknown) => String(v).slice(runId.length + 1);
  return {
    runId,
    get driver() {
      return driver;
    },
    get ogm() {
      return ogm;
    },
    get strictOgm() {
      return strictOgm;
    },
    warnings,
    id: (s) => `${runId}-${s}`,
    short,
    model: (name, o) => (o ?? ogm).model(name) as unknown as AnyModel,
    async ids(tx, cypher) {
      const res = await tx.run(cypher, { runId });
      return res.records.map((r) => short(r.get(0))).sort();
    },
  };
}
