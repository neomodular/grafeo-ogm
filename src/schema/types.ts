/** Recursive type for Neo4j property values (no `any`) */
export type Neo4jValue =
  | string
  | number
  | boolean
  | null
  | Neo4jValue[]
  | { [key: string]: Neo4jValue };

/** Generic fallback types */
export interface WhereInput {
  [key: string]: Neo4jValue | WhereInput | WhereInput[];
}
export interface MutationInput {
  [key: string]: Neo4jValue | MutationInput | MutationInput[];
}

export interface PropertyDefinition {
  name: string;
  type: string; // 'String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', enum name
  required: boolean;
  isArray: boolean;
  isListItemRequired: boolean; // For lists: inner non-nullable (e.g., [String!])
  isGenerated: boolean; // @id directive
  isUnique: boolean; // @unique directive
  isCypher: boolean; // @cypher directive (computed field, not stored)
  directives: string[]; // Directive names (e.g., ['id', 'unique'])
  defaultValue?: string; // @default directive
}

export interface RelationshipDefinition {
  fieldName: string; // e.g., 'books', 'hasStatus'
  type: string; // e.g., 'WRITTEN_BY', 'HAS_STATUS'
  direction: 'IN' | 'OUT';
  target: string; // e.g., 'Book', 'Status'
  properties?: string; // e.g., 'AuthorBookProps' (relationship properties type name)
  isArray: boolean; // [Book!]! vs Book
  isRequired: boolean; // ! at field level
}

export interface FulltextIndex {
  name: string; // e.g., 'BookTitleSearch'
  fields: string[]; // e.g., ['title']
}

export interface VectorIndex {
  indexName: string; // Neo4j vector index name
  queryName: string; // Spec metadata (preserved for GraphQL emitters)
  embeddingProperty: string; // Node property holding the Float[] embedding
  provider?: string; // Optional — enables searchByPhrase when set
}

export interface NodeDefinition {
  typeName: string; // e.g., 'Book' (the GraphQL type name)
  label: string; // Primary label (usually same as typeName)
  labels: string[]; // All labels from @node(labels: [...]) e.g., ['Entity', 'User']
  pluralName: string; // e.g., 'books'
  properties: Map<string, PropertyDefinition>;
  relationships: Map<string, RelationshipDefinition>;
  fulltextIndexes: FulltextIndex[];
  vectorIndexes?: VectorIndex[];
  implementsInterfaces: string[]; // Interface names e.g., ['Entity']
}

export interface InterfaceDefinition {
  name: string; // e.g., 'Entity'
  label: string; // Neo4j label shared by all implementors - same as name
  properties: Map<string, PropertyDefinition>;
  relationships: Map<string, RelationshipDefinition>;
  implementedBy: string[]; // Concrete type names e.g., ['User', 'Author', 'Publisher']
}

export interface RelationshipPropertiesDefinition {
  typeName: string; // e.g., 'AuthorBookProps'
  properties: Map<string, PropertyDefinition>;
  fulltextIndexes?: FulltextIndex[]; // @fulltext declared on the @relationshipProperties type
}

export interface SchemaMetadata {
  nodes: Map<string, NodeDefinition>;
  interfaces: Map<string, InterfaceDefinition>;
  relationshipProperties: Map<string, RelationshipPropertiesDefinition>;
  enums: Map<string, string[]>; // enum name -> values
  unions: Map<string, string[]>; // union name -> member type names
}
