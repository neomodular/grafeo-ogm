import { emitEnums } from '../../src/generator/type-emitters/enum-emitter';
import type { SchemaMetadata } from '../../src/schema/types';

function makeSchema(enums: Map<string, string[]>): SchemaMetadata {
  return {
    nodes: new Map(),
    interfaces: new Map(),
    relationshipProperties: new Map(),
    enums,
    unions: new Map(),
  };
}

describe('emitEnums', () => {
  it('converts UPPER_SNAKE_CASE to PascalCase member names', () => {
    const schema = makeSchema(
      new Map([
        ['UserOnboardingStep', ['WELCOME', 'PAYMENT', 'PENDING_APPROVAL']],
      ]),
    );
    const output = emitEnums(schema);
    expect(output).toContain('Welcome = "WELCOME"');
    expect(output).toContain('Payment = "PAYMENT"');
    expect(output).toContain('PendingApproval = "PENDING_APPROVAL"');
    expect(output).not.toContain('WELCOME = "WELCOME"');
    expect(output).not.toContain('PAYMENT = "PAYMENT"');
  });

  it('handles single-word enums', () => {
    const schema = makeSchema(
      new Map([['EquipmentPagePresentationMode', ['GRID', 'CARD', 'PICTURE']]]),
    );
    const output = emitEnums(schema);
    expect(output).toContain('Grid = "GRID"');
    expect(output).toContain('Card = "CARD"');
    expect(output).toContain('Picture = "PICTURE"');
  });

  it('handles multi-word with numbers and underscores', () => {
    const schema = makeSchema(
      new Map([['PaymentMethodType', ['CARD', 'US_BANK_ACCOUNT']]]),
    );
    const output = emitEnums(schema);
    expect(output).toContain('Card = "CARD"');
    expect(output).toContain('UsBankAccount = "US_BANK_ACCOUNT"');
  });

  it('preserves SortDirection with Asc/Desc', () => {
    const schema = makeSchema(new Map());
    const output = emitEnums(schema);
    expect(output).toContain('Asc = "ASC"');
    expect(output).toContain('Desc = "DESC"');
  });

  it('handles already PascalCase values without double-casing', () => {
    // Values like "Author" in EntityImplementation enum should stay as Author
    const schema = makeSchema(
      new Map([['EntityImplementation', ['Author', 'Organization']]]),
    );
    const output = emitEnums(schema);
    expect(output).toContain('Author = "Author"');
    expect(output).toContain('Organization = "Organization"');
  });

  it('sorts enums alphabetically', () => {
    const schema = makeSchema(
      new Map([
        ['Zebra', ['A']],
        ['Alpha', ['B']],
      ]),
    );
    const output = emitEnums(schema);
    const alphaIdx = output.indexOf('Alpha');
    const zebraIdx = output.indexOf('Zebra');
    expect(alphaIdx).toBeLessThan(zebraIdx);
  });
});
