import { Driver } from 'neo4j-driver';
import { Model } from '../src/model';
import { InterfaceModel } from '../src/interface-model';
import { OGMError } from '../src/errors';
import type {
  NodeDefinition,
  InterfaceDefinition,
  PropertyDefinition,
  SchemaMetadata,
} from '../src/schema/types';

/**
 * Issue #4 — integration coverage.
 *
 * `tests/cypher-sort-projection.spec.ts` proves `compileSortClause` itself
 * rejects multi-key entries. These specs prove the guard is actually REACHED
 * from the public API, and that it fires BEFORE anything is sent to the
 * driver — a compile-time failure, not a round-trip that returns wrong rows.
 */

// --- Helper factories -------------------------------------------------------

function prop(
  name: string,
  overrides: Partial<PropertyDefinition> = {},
): PropertyDefinition {
  return {
    name,
    type: 'String',
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

function nodeDef(
  typeName: string,
  props: PropertyDefinition[],
  overrides: Partial<NodeDefinition> = {},
): NodeDefinition {
  return {
    typeName,
    label: typeName,
    labels: [],
    pluralName: typeName.toLowerCase() + 's',
    properties: new Map(props.map((p) => [p.name, p])),
    relationships: new Map(),
    fulltextIndexes: [],
    implementsInterfaces: [],
    ...overrides,
  };
}

const categoryNode = nodeDef(
  'SafedoseCategory',
  [
    prop('id'),
    prop('name'),
    prop('isUrgent', { type: 'Boolean' }),
    prop('position', { type: 'Int' }),
    prop('lowerName', {
      isCypher: true,
      cypherStatement: 'RETURN toLower(this.name) AS lowerName',
      cypherColumnName: 'lowerName',
    }),
  ],
  { implementsInterfaces: ['Entity'] },
);

const entityInterface: InterfaceDefinition = {
  name: 'Entity',
  label: 'Entity',
  properties: new Map([
    ['id', prop('id')],
    ['name', prop('name')],
    ['position', prop('position', { type: 'Int' })],
  ]),
  relationships: new Map(),
  implementedBy: ['SafedoseCategory'],
};

const schema: SchemaMetadata = {
  nodes: new Map([['SafedoseCategory', categoryNode]]),
  interfaces: new Map([['Entity', entityInterface]]),
  relationshipProperties: new Map(),
  enums: new Map(),
  unions: new Map(),
};

function createMockDriver() {
  const mockSession = {
    run: jest.fn().mockResolvedValue({
      records: [],
      summary: {
        counters: {
          updates: () => ({
            nodesCreated: 0,
            nodesDeleted: 0,
            relationshipsCreated: 0,
            relationshipsDeleted: 0,
          }),
        },
      },
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
  const mockDriver = {
    session: jest.fn().mockReturnValue(mockSession),
  } as unknown as Driver;
  return { mockDriver, mockSession };
}

function getCypher(session: { run: jest.Mock }): string {
  return session.run.mock.calls[0][0] as string;
}

// The exact shape reported in issue #4.
//
// Typed as the DEFAULT `TSort` (`Record<string, 'ASC' | 'DESC'>`, see
// `FindOptions` in src/model.ts) — an index signature that happily admits any
// number of keys. This is precisely the untyped `ogm.model('X')` surface that
// generated `ExactlyOneKey` types cannot reach, and exactly why the
// runtime guard has to exist.
type LooseSort = Record<string, 'ASC' | 'DESC'>;

const MULTI_KEY: LooseSort[] = [{ isUrgent: 'DESC', position: 'ASC' }];
const DOCUMENTED: LooseSort[] = [{ isUrgent: 'DESC' }, { position: 'ASC' }];

// --- Tests ------------------------------------------------------------------

describe('sort entry arity — issue #4 integration', () => {
  let model: Model;
  let interfaceModel: InterfaceModel;
  let mockSession: ReturnType<typeof createMockDriver>['mockSession'];

  beforeEach(() => {
    Model.clearSelectionCache();
    const { mockDriver, mockSession: ms } = createMockDriver();
    mockSession = ms;
    model = new Model(categoryNode, schema, mockDriver);
    interfaceModel = new InterfaceModel(entityInterface, schema, mockDriver);
  });

  describe('Model', () => {
    it('find() rejects a multi-key sort entry', async () => {
      await expect(
        model.find({ options: { sort: MULTI_KEY } }),
      ).rejects.toThrow(OGMError);
    });

    it('find() fails before issuing any query to the driver', async () => {
      // The whole point of the fix: no round-trip returning wrongly-ordered
      // rows. The failure must happen at compile time.
      await expect(
        model.find({ options: { sort: MULTI_KEY } }),
      ).rejects.toThrow(/Sort entry has 2 keys/);

      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('findFirst() rejects a multi-key sort entry', async () => {
      await expect(
        model.findFirst({ options: { sort: MULTI_KEY } }),
      ).rejects.toThrow(/Sort entry has 2 keys \(isUrgent, position\)/);

      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('rejects a multi-key entry containing an @cypher sort field', async () => {
      await expect(
        model.find({
          options: { sort: [{ lowerName: 'ASC', position: 'DESC' }] },
        }),
      ).rejects.toThrow(/Sort entry has 2 keys \(lowerName, position\)/);

      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('still emits both ORDER BY terms for the documented form', async () => {
      await model.find({ options: { sort: DOCUMENTED } });

      expect(getCypher(mockSession)).toContain(
        'ORDER BY n.`isUrgent` DESC, n.`position` ASC',
      );
    });

    it('leaves single-key and unsorted queries untouched', async () => {
      await model.find({ options: { sort: [{ position: 'ASC' }] } });
      expect(getCypher(mockSession)).toContain('ORDER BY n.`position` ASC');

      const { mockDriver, mockSession: bare } = createMockDriver();
      await new Model(categoryNode, schema, mockDriver).find({});
      expect(getCypher(bare)).not.toContain('ORDER BY');
    });
  });

  describe('InterfaceModel', () => {
    it('find() rejects a multi-key sort entry', async () => {
      await expect(
        interfaceModel.find({
          options: { sort: [{ name: 'ASC', position: 'DESC' }] },
        }),
      ).rejects.toThrow(/Sort entry has 2 keys \(name, position\)/);

      expect(mockSession.run).not.toHaveBeenCalled();
    });

    it('still emits both ORDER BY terms for the documented form', async () => {
      await interfaceModel.find({
        options: { sort: [{ name: 'ASC' }, { position: 'DESC' }] },
      });

      expect(getCypher(mockSession)).toContain(
        'ORDER BY n.`name` ASC, n.`position` DESC',
      );
    });
  });
});
