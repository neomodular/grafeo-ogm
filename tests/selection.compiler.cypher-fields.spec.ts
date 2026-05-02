import {
  SelectionCompiler,
  type SelectionNode,
} from '../src/compilers/selection.compiler';
import { OGMError } from '../src/errors';
import {
  NodeDefinition,
  PropertyDefinition,
  RelationshipDefinition,
  SchemaMetadata,
} from '../src/schema/types';
import { CypherFieldScope } from '../src/utils/cypher-field-projection';

// ---------------------------------------------------------------------------
// Helpers (mirror tests/where.compiler.cypher-fields.spec.ts)
// ---------------------------------------------------------------------------

function storedProp(
  name: string,
  type = 'String',
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
    type,
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: false,
    directives: [],
    ...overrides,
  };
}

function cypherProp(
  name: string,
  statement: string,
  columnName?: string,
): PropertyDefinition {
  return {
    name,
    type: 'String',
    required: false,
    isArray: false,
    isListItemRequired: false,
    isGenerated: false,
    isUnique: false,
    isCypher: true,
    cypherStatement: statement,
    cypherColumnName: columnName,
    directives: ['cypher'],
  };
}

function makeRelDef(
  overrides: Partial<RelationshipDefinition> & {
    fieldName: string;
    type: string;
    target: string;
  },
): RelationshipDefinition {
  return {
    direction: 'OUT',
    isArray: true,
    isRequired: false,
    ...overrides,
  };
}

function makeNode(
  typeName: string,
  props: Array<[string, PropertyDefinition]>,
  rels: Array<[string, RelationshipDefinition]> = [],
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [typeName],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(props),
    relationships: new Map(rels),
    fulltextIndexes: [],
    implementsInterfaces: [],
  };
}

const statusNode = makeNode('Status', [
  ['id', storedProp('id', 'ID')],
  ['name', storedProp('name', 'String')],
  [
    'statusLowerName',
    cypherProp(
      'statusLowerName',
      'RETURN toLower(this.name) AS statusLowerName',
      'statusLowerName',
    ),
  ],
]);

const drugNode = makeNode(
  'Drug',
  [
    ['id', storedProp('id', 'ID')],
    ['drugName', storedProp('drugName', 'String')],
    [
      'insensitiveDrugName',
      cypherProp(
        'insensitiveDrugName',
        'RETURN toLower(this.drugName) AS insensitiveDrugName',
        'insensitiveDrugName',
      ),
    ],
    [
      'upperName',
      cypherProp(
        'upperName',
        'RETURN toUpper(this.drugName) AS shared',
        'shared',
      ),
    ],
    [
      'lowerName',
      cypherProp(
        'lowerName',
        'RETURN toLower(this.drugName) AS shared',
        'shared',
      ),
    ],
  ],
  [
    [
      'hasStatus',
      makeRelDef({
        fieldName: 'hasStatus',
        type: 'HAS_STATUS',
        target: 'Status',
      }),
    ],
  ],
);

const schema: SchemaMetadata = {
  nodes: new Map([
    ['Drug', drugNode],
    ['Status', statusNode],
  ]),
  interfaces: new Map(),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

// ---------------------------------------------------------------------------

describe('SelectionCompiler — @cypher field resolution', () => {
  let compiler: SelectionCompiler;
  beforeEach(() => {
    compiler = new SelectionCompiler(schema);
    compiler.clearCache();
  });

  describe('top-level @cypher scalar projection', () => {
    it('projects a @cypher field via its scope alias when scope is provided', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'id',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
        {
          fieldName: 'insensitiveDrugName',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
      ];

      const scope = new CypherFieldScope('n', [], '__sel');
      const out = compiler.compile(
        selection,
        'n',
        drugNode,
        5,
        0,
        undefined,
        undefined,
        scope,
      );

      expect(scope.hasAny()).toBe(true);
      expect(out).toBe(
        'n { .`id`, `insensitiveDrugName`: __sel_n_insensitiveDrugName }',
      );
      expect(scope.emit().join('\n')).toBe(
        [
          'CALL {',
          '  WITH n',
          '  WITH n AS this',
          '  RETURN toLower(this.drugName) AS insensitiveDrugName',
          '}',
          'WITH n, `insensitiveDrugName` AS __sel_n_insensitiveDrugName',
        ].join('\n'),
      );
    });

    it('projects @cypher mixed with stored fields preserving order', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'id',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
        {
          fieldName: 'insensitiveDrugName',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
        {
          fieldName: 'drugName',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
      ];

      const scope = new CypherFieldScope('n', [], '__sel');
      const out = compiler.compile(
        selection,
        'n',
        drugNode,
        5,
        0,
        undefined,
        undefined,
        scope,
      );

      expect(out).toBe(
        'n { .`id`, `insensitiveDrugName`: __sel_n_insensitiveDrugName, .`drugName` }',
      );
    });

    it('produces UNIQUE aliases for two @cypher fields sharing a columnName', () => {
      const selection: SelectionNode[] = [
        {
          fieldName: 'upperName',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
        {
          fieldName: 'lowerName',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
      ];

      const scope = new CypherFieldScope('n', [], '__sel');
      const out = compiler.compile(
        selection,
        'n',
        drugNode,
        5,
        0,
        undefined,
        undefined,
        scope,
      );

      expect(out).toContain('`upperName`: __sel_n_upperName');
      expect(out).toContain('`lowerName`: __sel_n_lowerName');
      const flat = scope.emit().join('\n');
      expect(flat).toContain('`shared` AS __sel_n_upperName');
      expect(flat).toContain('`shared` AS __sel_n_lowerName');
      expect(flat).toContain(
        'WITH n, __sel_n_upperName, `shared` AS __sel_n_lowerName',
      );
    });

    it('rejects a @cypher field on a NESTED related node (no scope available)', () => {
      // Nested relationships use list comprehensions which cannot host CALL
      // subqueries. The compiler must reject @cypher selections there.
      const selection: SelectionNode[] = [
        {
          fieldName: 'id',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
        {
          fieldName: 'hasStatus',
          isScalar: false,
          isRelationship: true,
          isConnection: false,
          children: [
            {
              fieldName: 'statusLowerName',
              isScalar: true,
              isRelationship: false,
              isConnection: false,
            },
          ],
        },
      ];

      const scope = new CypherFieldScope('n', [], '__sel');
      expect(() =>
        compiler.compile(
          selection,
          'n',
          drugNode,
          5,
          0,
          undefined,
          undefined,
          scope,
        ),
      ).toThrow(OGMError);
      expect(() =>
        compiler.compile(
          selection,
          'n',
          drugNode,
          5,
          0,
          undefined,
          undefined,
          scope,
        ),
      ).toThrow(/@cypher field "statusLowerName" on a related node/);
    });

    it('rejects a @cypher field at the top level when scope is null', () => {
      // Defensive: callers MUST pass a scope when @cypher might appear.
      const selection: SelectionNode[] = [
        {
          fieldName: 'insensitiveDrugName',
          isScalar: true,
          isRelationship: false,
          isConnection: false,
        },
      ];
      expect(() =>
        compiler.compile(selection, 'n', drugNode, 5, 0, undefined, undefined),
      ).toThrow(OGMError);
    });
  });

  describe('selectionSet string parsing path', () => {
    it('compiles { id, insensitiveDrugName } via parseSelectionSet', () => {
      const parsed = compiler.parseSelectionSet('{ id insensitiveDrugName }');
      const scope = new CypherFieldScope('n', [], '__sel');
      const out = compiler.compile(
        parsed,
        'n',
        drugNode,
        5,
        0,
        undefined,
        undefined,
        scope,
      );
      expect(scope.hasAny()).toBe(true);
      expect(out).toBe(
        'n { .`id`, `insensitiveDrugName`: __sel_n_insensitiveDrugName }',
      );
    });
  });
});
