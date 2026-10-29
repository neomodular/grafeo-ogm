/**
 * Schema + seed for the live (server-side) Cypher performance harness.
 *
 * Dataset (SCALE=1): 10k PfUser in fan-out buckets (100 users with 100
 * posts, 900 with 10, 9000 with 1) = 28k PfPost; 1k PfTag (3 per post,
 * edge property `weight`, 84k edges); 28k PfComment (one per post); 1k
 * PfNote (interface PfContent = PfPost | PfNote). Constraints as
 * `db push` would create them (every @unique).
 */
export const typeDefs = /* GraphQL */ `
  interface PfContent {
    id: ID!
    title: String
  }
  type PfTagged @relationshipProperties {
    weight: Int
  }
  type PfUser @node {
    id: ID! @unique
    email: String! @unique
    name: String
    age: Int
    bucket: Int
    tenantId: String
    posts: [PfPost!]! @relationship(type: "PF_WROTE", direction: OUT)
    content: [PfContent!]! @relationship(type: "PF_WROTE", direction: OUT)
    postCount: Int
      @cypher(
        statement: "MATCH (this)-[:PF_WROTE]->(p:PfPost) RETURN count(p) AS c"
        columnName: "c"
      )
  }
  type PfPost implements PfContent @node {
    id: ID! @unique
    title: String
    score: Int
    tenantId: String
    author: PfUser! @relationship(type: "PF_WROTE", direction: IN)
    tags: [PfTag!]!
      @relationship(type: "PF_TAGGED", direction: OUT, properties: "PfTagged")
    comments: [PfComment!]! @relationship(type: "PF_ON", direction: IN)
  }
  type PfNote implements PfContent @node {
    id: ID! @unique
    title: String
  }
  type PfTag @node {
    id: ID! @unique
    name: String! @unique
    posts: [PfPost!]!
      @relationship(type: "PF_TAGGED", direction: IN, properties: "PfTagged")
  }
  type PfComment @node {
    id: ID! @unique
    body: String
    post: PfPost! @relationship(type: "PF_ON", direction: OUT)
  }
`;

export const CONSTRAINTS = [
  'CREATE CONSTRAINT pf_user_id IF NOT EXISTS FOR (n:PfUser) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT pf_user_email IF NOT EXISTS FOR (n:PfUser) REQUIRE n.email IS UNIQUE',
  'CREATE CONSTRAINT pf_post_id IF NOT EXISTS FOR (n:PfPost) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT pf_note_id IF NOT EXISTS FOR (n:PfNote) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT pf_tag_id IF NOT EXISTS FOR (n:PfTag) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT pf_tag_name IF NOT EXISTS FOR (n:PfTag) REQUIRE n.name IS UNIQUE',
  'CREATE CONSTRAINT pf_comment_id IF NOT EXISTS FOR (n:PfComment) REQUIRE n.id IS UNIQUE',
];

export const SEED_STATEMENTS = (scale: number): string[] => {
  const users = 10000 * scale;
  return [
    `UNWIND range(0, ${users - 1}) AS i
     CALL { WITH i CREATE (:PfUser { id: 'u' + i, email: 'u' + i + '@x.io', name: 'user ' + i,
       age: i % 90, bucket: CASE WHEN i < ${users / 100} THEN 100 WHEN i < ${users / 10} THEN 10 ELSE 1 END,
       tenantId: 't' + (i % 10) }) } IN TRANSACTIONS OF 5000 ROWS`,
    `UNWIND range(0, ${1000 - 1}) AS i
     CALL { WITH i CREATE (:PfTag { id: 'g' + i, name: 'tag' + i }) } IN TRANSACTIONS OF 5000 ROWS`,
    `MATCH (u:PfUser)
     CALL { WITH u UNWIND range(0, u.bucket - 1) AS j
       CREATE (u)-[:PF_WROTE]->(:PfPost { id: u.id + '-p' + j, title: 'post ' + j + ' of ' + u.id, score: j, tenantId: u.tenantId })
     } IN TRANSACTIONS OF 500 ROWS`,
    `MATCH (p:PfPost)
     CALL { WITH p
       WITH p, toInteger(rand() * 997) AS k
       MATCH (g:PfTag) WHERE g.id IN ['g' + k, 'g' + ((k + 1) % 1000), 'g' + ((k + 2) % 1000)]
       CREATE (p)-[:PF_TAGGED { weight: k % 7 }]->(g)
     } IN TRANSACTIONS OF 2000 ROWS`,
    `MATCH (p:PfPost)
     CALL { WITH p CREATE (:PfComment { id: p.id + '-c', body: 'c' })-[:PF_ON]->(p) } IN TRANSACTIONS OF 5000 ROWS`,
    `UNWIND range(0, 999) AS i
     CALL { WITH i MATCH (u:PfUser { id: 'u' + i }) CREATE (u)-[:PF_WROTE]->(:PfNote { id: 'note' + i, title: 'note ' + i }) } IN TRANSACTIONS OF 5000 ROWS`,
  ];
};
