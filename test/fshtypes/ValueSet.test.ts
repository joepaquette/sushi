import 'jest-extended';
import { ValueSet } from '../../src/fshtypes/ValueSet';

describe('ValueSet', () => {
  describe('#constructor', () => {
    it('should set the properties correctly', () => {
      const vs = new ValueSet('MyValueSet');
      expect(vs.name).toBe('MyValueSet');
      expect(vs.id).toBe('MyValueSet');
      expect(vs.title).toBeUndefined();
      expect(vs.description).toBeUndefined();
      expect(vs.components).toBeEmpty();
    });
  });
});