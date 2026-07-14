/** Reference relationship from a cloned node to a shared/lookup node. */
export interface SubgraphReferenceRelationship {
  fromLabel: string;
  relationshipType: string;
  direction: 'OUT' | 'IN';
}

/** Configuration for clone/delete operations — domain-agnostic blueprint. */
export interface SubgraphConfig {
  ownedLabels: string[];
  ownedRelationships: string[];
  maxLevel: number;
  referenceRelationships: SubgraphReferenceRelationship[];
}

/** Clone result. */
export interface SubgraphCloneResult {
  clonedRootId: string;
  /** originalId → newId for every successfully cloned node. */
  nodeMapping: Map<string, string>;
  /**
   * label → newId[] over the successfully cloned nodes (v1.13.0).
   * A node contributes once per label it carries, so a multi-label node
   * appears under each of its labels. Every id here is also a value of
   * `nodeMapping`; the converse holds only for nodes with at least one label.
   */
  nodesByLabel: Map<string, string[]>;
}

/** Delete result. */
export interface SubgraphDeleteResult {
  deletedCount: number;
}
