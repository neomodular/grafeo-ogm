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
  nodeMapping: Map<string, string>;
}

/** Delete result. */
export interface SubgraphDeleteResult {
  deletedCount: number;
}
