/**
 * v2.11.0 — strict item 23: `@node(labels: [...])` as in @neo4j/graphql
 * 5.x (`getLabels`): the listed labels REPLACE the type name. Reads match
 * all of them, creates write exactly them, constraints / indexes go on
 * labels[0], and `__typename` still resolves to the GraphQL type name.
 * Default mode keeps 2.x (see `node-labels.byte-identical.spec.ts`) and
 * warns once per affected type at construction.
 */
import { Driver } from 'neo4j-driver';
import { OGM } from '../src/ogm';
import { OGMError } from '../src/errors';
import {
  buildLabelOgm,
  labelShapes,
  labelStatements,
  runLabelShape,
} from './node-labels.cases';
import { Recorded, recordingDriver } from './strict-mode.writes.cases';

const strictRun = (name: string) => runLabelShape(labelShapes[name], true);

describe('strict item 23 — @node(labels) replaces the type name', () => {
  describe('default-mode warning', () => {
    it('warns once per type whose labels are not just its name, at construction', () => {
      const warn = jest.fn();
      buildLabelOgm([], undefined, warn);
      const messages = warn.mock.calls.map((c) => String(c[0]));
      const item24 = messages.filter((m) => m.includes('@node(labels'));
      // Person ["Human"], Dog ["K9","Pet"], Cat ["Cat","Pet"]; Toy has none.
      expect(item24).toHaveLength(3);
      const person = item24.find((m) => m.startsWith('[OGM] Person '))!;
      expect(person).toContain('2.x matches (n:Person), creates :Person:Human');
      expect(person).toContain('constraints on :Human');
      expect(person).toContain('nodes written without :Person');
      expect(person).toContain('data-migration decision');
      expect(person).toContain('Enable `strict: true` (default in 3.0)');
      const cat = item24.find((m) => m.startsWith('[OGM] Cat '))!;
      expect(cat).toContain(
        'does not match :Cat nodes that lack the other labels',
      );
    });

    it('never warns under strict', () => {
      const warn = jest.fn();
      buildLabelOgm([], true, warn);
      expect(
        warn.mock.calls.filter((c) => String(c[0]).includes('@node(labels')),
      ).toHaveLength(0);
    });

    it('does not warn for labels: ["<TypeName>"] or a bare @node', () => {
      const warn = jest.fn();
      new OGM({
        typeDefs: `type Person @node(labels: ["Person"]) { id: ID! }
          type Toy @node { id: ID! }`,
        driver: recordingDriver([]) as Driver,
        logger: { debug: () => {}, warn },
      });
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('strict compile', () => {
    it('reads match every listed label, never the type name', async () => {
      expect((await strictRun('find (default selection)'))[0]).toMatch(
        /^MATCH \(n:`Human`\)\n/,
      );
      expect((await strictRun('find with runtime labels'))[0]).toMatch(
        /^MATCH \(n:`Human`:`Vip`\)\n/,
      );
      expect((await strictRun('count'))[0]).toMatch(/^MATCH \(n:`K9`:`Pet`\)/);
      for (const shape of ['fulltext find', 'searchByVector'])
        expect((await strictRun(shape))[0]).toContain('WHERE n:`Human`');
    });

    it('relationship targets, filters, connections and aggregates use the target labels', async () => {
      const [cypher] = await strictRun(
        'find: concrete, interface, union and connection selections',
      );
      expect(cypher).toContain('(n)-[:`FAV`]->(n0:`K9`:`Pet`)');
      expect(cypher).toContain('(n)-[:`KNOWS`]->(n0:`Human`)');
      expect(cypher).toContain('(n)-[e0:`KNOWS`]->(n0:`Human`) | 1');
      expect(cypher).toContain('COUNT { (n)-[e0:`KNOWS`]->(n0:`Human`) }');
      expect(cypher).not.toMatch(/:`(Person|Dog)`/);
      const [where] = await strictRun(
        'where: quantifiers, abstract and union filters',
      );
      expect(where).toContain('(n)-[:`FAV`]->(r0:`K9`:`Pet`)');
      expect(where).toContain('(n)-[:`HAS`]->(r6:`K9`:`Pet`)');
      expect(where).toContain('(r4:`K9`:`Pet` OR r4:`Cat`:`Pet`)');
      expect(where).not.toMatch(/:`(Person|Dog)`/);
    });

    it('__typename resolves to the type name by label set', async () => {
      const [cypher] = await strictRun(
        'find: concrete, interface, union and connection selections',
      );
      expect(cypher).toContain(
        "__typename: CASE WHEN n0:`K9`:`Pet` THEN 'Dog' WHEN n0:`Cat`:`Pet` THEN 'Cat' END",
      );
      expect(cypher).toContain(
        "__typename: CASE WHEN n0:`K9`:`Pet` THEN 'Dog' WHEN n0:`Toy` THEN 'Toy' END",
      );
      expect(cypher).not.toContain('labels(n0)');
      const [iface] = await strictRun('interface find');
      expect(iface).toMatch(
        /^MATCH \(n:\(\(`K9`&`Pet`\)\|\(`Cat`&`Pet`\)\)\)\n/,
      );
      expect(iface).toContain(
        "CASE WHEN n:`K9`:`Pet` THEN 'Dog' WHEN n:`Cat`:`Pet` THEN 'Cat' END AS __typename",
      );
      expect(iface).toContain('WITH n WHERE n:`K9`:`Pet`');
      const [count] = await strictRun('interface count with labels');
      expect(count).toBe(
        'MATCH (n:((`K9`&`Pet`)|(`Cat`&`Pet`))&`Vip`)\nRETURN count(n) AS count',
      );
    });

    it('creates write exactly the listed labels', async () => {
      const [create] = await strictRun('create');
      expect(create).toMatch(/^CREATE \(n:`K9`:`Pet` \{/);
      expect(create).toContain('MATCH (n_cn0:`Human`)');
      const [withLabels] = await strictRun('create with labels');
      expect(withLabels).toMatch(/^CREATE \(n:`Human` \{/);
      expect(withLabels).toContain('CREATE (n_c0:`Cat`:`Pet` {');
      expect((await strictRun('createMany'))[0]).toContain(
        'CREATE (n:`K9`:`Pet` {',
      );
      expect((await strictRun('createMany skipDuplicates'))[0]).toContain(
        'MERGE (n:`K9`:`Pet` {',
      );
      expect((await strictRun('upsert'))[0]).toMatch(
        /^MERGE \(n:`K9`:`Pet` \{/,
      );
    });

    it('updates, connect / disconnect, deletes and setLabels match the listed labels', async () => {
      const [update] = await strictRun(
        'update: set, connect, disconnect, nested update / delete',
      );
      expect(update).toMatch(/^MATCH \(n:`Human`\)\n/);
      expect(update).toContain('MATCH (target:`K9`:`Pet`)');
      expect(update).toContain('(n_disc1:`K9`:`Pet`)');
      expect(update).toContain(
        '(target_pets_0:`K9`:`Pet` OR target_pets_0:`Cat`:`Pet`)',
      );
      expect(update).not.toMatch(/:`(Person|Dog)`/);
      const [del] = await strictRun('delete with cascade');
      expect(del).toContain('(cascade_0:`K9`:`Pet`)');
      expect((await strictRun('setLabels'))[0]).toMatch(
        /^MATCH \(n:`K9`:`Pet`\)/,
      );
    });

    it('policies key per-member predicates by the member labels', async () => {
      const [find, , connect] = await strictRun(
        'policies: find, update and delete',
      );
      expect(find).toContain(
        '(NOT r0:`K9`:`Pet` OR (r0.`tenantId` = $param2))',
      );
      expect(find).toContain(
        '(n)-[:`FAV`]->(n0:`K9`:`Pet`) WHERE (n0.`tenantId` = $param3)',
      );
      expect(connect).toContain(
        'MATCH (target:`K9`:`Pet`)\nWHERE target.`id` = $param1 AND (target.`tenantId` = $param2)',
      );
    });

    it('constraints and indexes go on labels[0]', () => {
      expect(labelStatements(buildLabelOgm([], true))).toEqual([
        'CREATE FULLTEXT INDEX PersonName IF NOT EXISTS FOR (n:Human) ON EACH [n.name]',
        'CREATE CONSTRAINT Human_id_unique IF NOT EXISTS FOR (n:Human) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT Human_email_unique IF NOT EXISTS FOR (n:Human) REQUIRE n.email IS UNIQUE',
        'CREATE CONSTRAINT K9_id_unique IF NOT EXISTS FOR (n:K9) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT Cat_id_unique IF NOT EXISTS FOR (n:Cat) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT Toy_id_unique IF NOT EXISTS FOR (n:Toy) REQUIRE n.id IS UNIQUE',
        "CREATE VECTOR INDEX PersonEmb IF NOT EXISTS FOR (n:Human) ON (n.embedding) OPTIONS {indexConfig: {`vector.dimensions`: 2, `vector.similarity_function`: 'cosine'}}",
      ]);
    });

    it('assertIndexesAndConstraints creates them on labels[0]', async () => {
      const records: Recorded[] = [];
      const ogm = buildLabelOgm(records, true);
      await ogm.assertIndexesAndConstraints({ options: { create: true } });
      expect(records.map((r) => r.cypher)).toContain(
        'CREATE CONSTRAINT K9_id_unique IF NOT EXISTS FOR (n:K9) REQUIRE n.id IS UNIQUE',
      );
      expect(records.some((r) => r.cypher.includes('(n:Dog)'))).toBe(false);
    });
  });

  describe('labels that include the type name', () => {
    const typeDefs = `type Person @node(labels: ["Person", "Entity"]) {
      id: ID! @id @unique
      name: String
    }
    type Book @node(labels: ["Entity", "Book"]) {
      id: ID! @id @unique
    }`;
    const build = (strict: boolean, records: Recorded[] = []) =>
      new OGM({
        typeDefs,
        driver: recordingDriver(records) as Driver,
        strict,
      });

    it('reads match all labels; creates and constraints follow the listed order', async () => {
      const records: Recorded[] = [];
      const ogm = build(true, records);
      await ogm.model('Person').find({ selectionSet: '{ id }' });
      await ogm.model('Person').create({ input: [{ name: 'a' }] });
      await ogm.model('Book').find({ selectionSet: '{ id }' });
      expect(records[0].cypher).toMatch(/^MATCH \(n:`Person`:`Entity`\)/);
      expect(records[1].cypher).toMatch(/^CREATE \(n:`Person`:`Entity` \{/);
      expect(records[2].cypher).toMatch(/^MATCH \(n:`Entity`:`Book`\)/);
      await ogm.assertIndexesAndConstraints({ options: { create: true } });
      const statements = records.slice(3).map((r) => r.cypher);
      expect(statements).toEqual([
        'CREATE CONSTRAINT Person_id_unique IF NOT EXISTS FOR (n:Person) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT Entity_id_unique IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE',
      ]);
    });

    it('default mode keeps (n:<TypeName>) reads and :<TypeName>:<labels> creates', async () => {
      const records: Recorded[] = [];
      const ogm = build(false, records);
      await ogm.model('Book').find({ selectionSet: '{ id }' });
      await ogm.model('Book').create({ input: [{}] });
      expect(records[0].cypher).toMatch(/^MATCH \(n:`Book`\)/);
      expect(records[1].cypher).toMatch(/^CREATE \(n:`Book`:`Entity` \{/);
    });
  });

  describe('label placeholders', () => {
    const typeDefs = `type Doc @node(labels: ["Doc", "$jwt.tenant"]) { id: ID! }`;

    it('strict mode rejects $jwt / $context labels at construction', () => {
      expect(
        () =>
          new OGM({
            typeDefs,
            driver: recordingDriver([]) as Driver,
            strict: true,
          }),
      ).toThrow(OGMError);
      expect(
        () =>
          new OGM({
            typeDefs,
            driver: recordingDriver([]) as Driver,
            strict: true,
          }),
      ).toThrow(/label placeholder "\$jwt.tenant" is not supported/);
    });

    it('default mode keeps 2.x: reads by type name, creates reject the label', async () => {
      const records: Recorded[] = [];
      const ogm = new OGM({
        typeDefs,
        driver: recordingDriver(records) as Driver,
      });
      await ogm.model('Doc').find({ selectionSet: '{ id }' });
      expect(records[0].cypher).toMatch(/^MATCH \(n:`Doc`\)/);
      await expect(
        ogm.model('Doc').create({ input: [{ id: 'd' }] }),
      ).rejects.toThrow(OGMError);
    });
  });
});
