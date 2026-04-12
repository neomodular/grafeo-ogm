import { emitInterfaceTypes } from '../../src/generator/type-emitters/interface-emitter';
import type {
  SchemaMetadata,
  InterfaceDefinition,
  PropertyDefinition,
  RelationshipDefinition,
} from '../../src/schema/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProp(
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

function makeRel(
  fieldName: string,
  target: string,
  overrides: Partial<RelationshipDefinition> = {},
): RelationshipDefinition {
  return {
    fieldName,
    type: 'HAS_' + target.toUpperCase(),
    direction: 'OUT',
    target,
    isArray: true,
    isRequired: true,
    ...overrides,
  };
}

function makeInterfaceDef(
  name: string,
  overrides: Partial<InterfaceDefinition> = {},
): InterfaceDefinition {
  return {
    name,
    label: name,
    properties: new Map(),
    relationships: new Map(),
    implementedBy: [],
    ...overrides,
  };
}

function makeSchema(
  interfaces: Map<string, InterfaceDefinition>,
): SchemaMetadata {
  return {
    nodes: new Map(),
    interfaces,
    relationshipProperties: new Map(),
    enums: new Map(),
    unions: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitInterfaceTypes', () => {
  it('emits an interface with only scalar properties', () => {
    const schema = makeSchema(
      new Map([
        [
          'Entity',
          makeInterfaceDef('Entity', {
            properties: new Map([
              ['id', makeProp('id', { type: 'ID', required: true })],
              ['name', makeProp('name', { type: 'String', required: false })],
            ]),
          }),
        ],
      ]),
    );

    const output = emitInterfaceTypes(schema);

    expect(output).toContain('export type Entity = {');
    expect(output).toContain('  id: Scalars["ID"]["output"];');
    expect(output).toContain('  name?: Maybe<Scalars["String"]["output"]>;');
    expect(output).toContain('};');
  });

  it('does NOT emit Implementation enum when implementedBy is empty', () => {
    const schema = makeSchema(
      new Map([
        [
          'Entity',
          makeInterfaceDef('Entity', {
            properties: new Map([['id', makeProp('id', { required: true })]]),
            implementedBy: [],
          }),
        ],
      ]),
    );

    const output = emitInterfaceTypes(schema);

    expect(output).toContain('export type Entity = {');
    expect(output).not.toContain('EntityImplementation');
  });

  it('emits Implementation enum when implementedBy has members', () => {
    const schema = makeSchema(
      new Map([
        [
          'Entity',
          makeInterfaceDef('Entity', {
            properties: new Map([['id', makeProp('id', { required: true })]]),
            implementedBy: ['Organization', 'Author', 'User'],
          }),
        ],
      ]),
    );

    const output = emitInterfaceTypes(schema);

    expect(output).toContain('export type Entity = {');
    expect(output).toContain('export enum EntityImplementation {');
    // Members should be sorted alphabetically
    expect(output).toContain('  Author = "Author",');
    expect(output).toContain('  Organization = "Organization",');
    expect(output).toContain('  User = "User",');

    // Verify sort order
    const authorIdx = output.indexOf('Author = "Author"');
    const orgIdx = output.indexOf('Organization = "Organization"');
    const userIdx = output.indexOf('User = "User"');
    expect(authorIdx).toBeLessThan(orgIdx);
    expect(orgIdx).toBeLessThan(userIdx);
  });

  it('emits relationship fields and connection fields for array relationships', () => {
    const schema = makeSchema(
      new Map([
        [
          'Entity',
          makeInterfaceDef('Entity', {
            properties: new Map([['id', makeProp('id', { required: true })]]),
            relationships: new Map([
              ['books', makeRel('books', 'Book', { isArray: true })],
            ]),
          }),
        ],
      ]),
    );

    const output = emitInterfaceTypes(schema);

    expect(output).toContain('  id: Scalars["String"]["output"];');
    // Array relationship field
    expect(output).toContain('  books: Array<Book>;');
    // Connection field
    expect(output).toContain('  booksConnection: EntityBooksConnection;');
  });

  it('emits singular required relationship field', () => {
    const schema = makeSchema(
      new Map([
        [
          'Entity',
          makeInterfaceDef('Entity', {
            relationships: new Map([
              [
                'hasStatus',
                makeRel('hasStatus', 'Status', {
                  isArray: false,
                  isRequired: true,
                }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitInterfaceTypes(schema);

    expect(output).toContain('  hasStatus: Status;');
    expect(output).toContain(
      '  hasStatusConnection: EntityHasStatusConnection;',
    );
  });

  it('emits optional singular relationship with Maybe wrapper', () => {
    const schema = makeSchema(
      new Map([
        [
          'Entity',
          makeInterfaceDef('Entity', {
            relationships: new Map([
              [
                'resource',
                makeRel('resource', 'Resource', {
                  isArray: false,
                  isRequired: false,
                }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitInterfaceTypes(schema);

    expect(output).toContain('  resource?: Maybe<Resource>;');
    expect(output).toContain('  resourceConnection: EntityResourceConnection;');
  });

  it('sorts interfaces alphabetically', () => {
    const schema = makeSchema(
      new Map([
        [
          'Zebra',
          makeInterfaceDef('Zebra', {
            properties: new Map([['id', makeProp('id', { required: true })]]),
          }),
        ],
        [
          'Alpha',
          makeInterfaceDef('Alpha', {
            properties: new Map([['id', makeProp('id', { required: true })]]),
          }),
        ],
      ]),
    );

    const output = emitInterfaceTypes(schema);

    const alphaIdx = output.indexOf('export type Alpha');
    const zebraIdx = output.indexOf('export type Zebra');
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });

  it('skips @cypher properties on interfaces', () => {
    const schema = makeSchema(
      new Map([
        [
          'Entity',
          makeInterfaceDef('Entity', {
            properties: new Map([
              ['id', makeProp('id', { required: true })],
              ['computed', makeProp('computed', { isCypher: true })],
            ]),
          }),
        ],
      ]),
    );

    const output = emitInterfaceTypes(schema);

    expect(output).toContain('  id:');
    expect(output).not.toContain('computed');
  });

  it('emits array scalar properties correctly', () => {
    const schema = makeSchema(
      new Map([
        [
          'Entity',
          makeInterfaceDef('Entity', {
            properties: new Map([
              [
                'tags',
                makeProp('tags', {
                  type: 'String',
                  required: true,
                  isArray: true,
                }),
              ],
            ]),
          }),
        ],
      ]),
    );

    const output = emitInterfaceTypes(schema);

    expect(output).toContain('  tags: Array<Scalars["String"]["output"]>;');
  });

  it('handles enum-typed properties on interfaces', () => {
    const schema: SchemaMetadata = {
      nodes: new Map(),
      interfaces: new Map([
        [
          'Entity',
          makeInterfaceDef('Entity', {
            properties: new Map([
              [
                'status',
                makeProp('status', { type: 'StatusEnum', required: true }),
              ],
            ]),
          }),
        ],
      ]),
      relationshipProperties: new Map(),
      enums: new Map([['StatusEnum', ['ACTIVE', 'INACTIVE']]]),
      unions: new Map(),
    };

    const output = emitInterfaceTypes(schema);

    expect(output).toContain('  status: StatusEnum;');
  });

  it('returns empty string for no interfaces', () => {
    const schema = makeSchema(new Map());
    const output = emitInterfaceTypes(schema);

    expect(output).toBe('');
  });
});
