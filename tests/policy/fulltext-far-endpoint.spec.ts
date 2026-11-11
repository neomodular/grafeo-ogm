/**
 * v2.28.1 — security: a relationship fulltext leaf checks its FAR endpoint
 * (the related node): the relationship type, the target's label and the
 * target's `read` policy (per member for an interface target), before the
 * rows are reduced to the root. Pre-2.28.1 only the root was checked, so
 * edge text on a relationship to a hidden node was searchable.
 */
import { permissive } from '../../src/policy/types';
import { compile, createCompileOnlyOgm } from '../../src/testing';

const typeDefs = /* GraphQL */ `
  type Tagged
    @relationshipProperties
    @fulltext(indexes: [{ indexName: "TaggedFt", fields: ["note"] }]) {
    note: String
  }
  type Tag @node {
    id: ID! @unique
    name: String
    charts: [Chart!]!
      @relationship(type: "TAGS", direction: OUT, properties: "Tagged")
    items: [Content!]!
      @relationship(type: "HAS", direction: OUT, properties: "Tagged")
  }
  interface Content {
    id: ID!
  }
  type Chart implements Content @node {
    id: ID! @unique
    secret: Boolean
  }
  type Note implements Content @node {
    id: ID! @unique
  }
`;

const policies = {
  Chart: [
    permissive({ operations: ['read'], when: () => ({ secret: false }) }),
  ],
};

const charts = { charts: { TaggedFt: { phrase: 'merger' } } };
const items = { items: { TaggedFt: { phrase: 'merger' } } };

describe('relationship fulltext far endpoint (2.28.1)', () => {
  it('applies the target read policy, then the where, without param collisions', async () => {
    const ogm = createCompileOnlyOgm({ typeDefs, policies });
    const Tag = compile(ogm.withContext({}).model('Tag'));
    const q = await Tag.find({ fulltext: charts, where: { name: 'a' } });
    expect(q.cypher).toContain(
      "WITH rel, startNode(rel) AS n, endNode(rel) AS n__far, score\nWHERE type(rel) = 'TAGS' AND n__far:`Chart` AND (n__far.`secret` = $param0)\nWITH n, max(score) AS score",
    );
    expect(q.params.param0).toBe(false);
    expect(q.cypher).toContain('n.`name` = $param1');
    expect(q.params.param1).toBe('a');

    const count = await Tag.count({ fulltext: charts });
    expect(count.cypher).toContain(
      "WHERE type(rel) = 'TAGS' AND n__far:`Chart` AND (n__far.`secret` = $param0)",
    );
  });

  it('applies each member policy on an interface target', async () => {
    const ogm = createCompileOnlyOgm({ typeDefs, policies });
    const q = await compile(ogm.withContext({}).model('Tag')).find({
      fulltext: items,
    });
    expect(q.cypher).toContain(
      "WHERE type(rel) = 'HAS' AND ((n__far:`Chart` OR n__far:`Note`) AND (NOT n__far:`Chart` OR (n__far.`secret` = $param0)))",
    );
  });

  it('without policies (or bypassed): the type and label checks only', async () => {
    const expected =
      "WITH rel, startNode(rel) AS n, endNode(rel) AS n__far, score\nWHERE type(rel) = 'TAGS' AND n__far:`Chart`\nWITH n, max(score) AS score";
    const plain = createCompileOnlyOgm({ typeDefs });
    expect(
      (await compile(plain.model('Tag')).find({ fulltext: charts })).cypher,
    ).toContain(expected);
    const pol = createCompileOnlyOgm({ typeDefs, policies });
    expect(
      (
        await compile(pol.withContext({}).model('Tag')).find({
          fulltext: charts,
          unsafe: { bypassPolicies: true },
        })
      ).cypher,
    ).toContain(expected);
    // An interface target without policies: the member restriction only
    // in strict mode, as for `itemsConnection`.
    expect(
      (await compile(plain.model('Tag')).find({ fulltext: items })).cypher,
    ).toContain("WHERE type(rel) = 'HAS'\nWITH n, max(score) AS score");
    const strict = createCompileOnlyOgm({ typeDefs, strict: true });
    expect(
      (await compile(strict.model('Tag')).find({ fulltext: items })).cypher,
    ).toContain(
      "WHERE type(rel) = 'HAS' AND (n__far:`Chart` OR n__far:`Note`)\n",
    );
  });
});
