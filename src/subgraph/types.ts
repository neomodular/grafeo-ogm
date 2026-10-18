/** Reference relationship from a cloned node to a shared/lookup node. */
export interface SubgraphReferenceRelationship {
  fromLabel: string;
  relationshipType: string;
  direction: 'OUT' | 'IN';
}

/** Configuration for clone/delete operations — domain-agnostic blueprint. */
export interface SubgraphConfig {
  ownedLabels: string[];
  /**
   * Label the root node must carry; defaults to `ownedLabels[0]` (v2.5.0).
   * The root is matched as `(:rootLabel {id})`. Before v2.5.0 it was
   * matched by `id` alone, so a node of any label with that id became a
   * root, and the lookup scanned every node.
   */
  rootLabel?: string;
  /**
   * Relationship types the traversal follows from the root. A bare
   * `'TYPE'` is followed OUTGOING only; write `'<TYPE'` for incoming and
   * `'<TYPE>'` for both directions (v2.5.0). Before v2.5.0 a bare type was
   * followed both ways, so the traversal could climb from a shared child
   * up to another parent and take it in too.
   */
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
