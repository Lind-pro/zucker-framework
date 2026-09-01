import { describe, it, expect } from 'vitest';
import { TermExpressionParser } from './term-expression-parser';

describe('TermExpressionParser', () => {
  const parser = new TermExpressionParser();

  describe('simple conditions', () => {
    it('should parse equality', () => {
      const terms = parser.parse("name = 'Alice'");
      expect(terms).toHaveLength(1);
      expect(terms[0].column).toBe('name');
      expect(terms[0].termType).toBe('eq');
      expect(terms[0].value).toBe('Alice');
    });

    it('should parse not-equal with !=', () => {
      const terms = parser.parse("status != 'deleted'");
      expect(terms[0].termType).toBe('neq');
      expect(terms[0].value).toBe('deleted');
    });

    it('should parse not-equal with <>', () => {
      const terms = parser.parse("status <> 'deleted'");
      expect(terms[0].termType).toBe('neq');
    });

    it('should parse greater than', () => {
      const terms = parser.parse('age > 18');
      expect(terms[0].termType).toBe('gt');
      expect(terms[0].value).toBe(18);
    });

    it('should parse greater than or equal', () => {
      const terms = parser.parse('age >= 18');
      expect(terms[0].termType).toBe('gte');
    });

    it('should parse less than', () => {
      const terms = parser.parse('age < 65');
      expect(terms[0].termType).toBe('lt');
    });

    it('should parse less than or equal', () => {
      const terms = parser.parse('age <= 65');
      expect(terms[0].termType).toBe('lte');
    });

    it('should parse negative numbers', () => {
      const terms = parser.parse('temperature > -10');
      expect(terms[0].value).toBe(-10);
    });
  });

  describe('like', () => {
    it('should parse like', () => {
      const terms = parser.parse("name like '%test%'");
      expect(terms[0].termType).toBe('like');
      expect(terms[0].value).toBe('%test%');
    });

    it('should parse not like', () => {
      const terms = parser.parse("name not like '%bad%'");
      expect(terms[0].termType).toBe('not-like');
      expect(terms[0].value).toBe('%bad%');
    });
  });

  describe('in / not in', () => {
    it('should parse in with string values', () => {
      const terms = parser.parse("status in ('active', 'pending')");
      expect(terms[0].termType).toBe('in');
      expect(terms[0].value).toEqual(['active', 'pending']);
    });

    it('should parse in with numeric values', () => {
      const terms = parser.parse('id in (1, 2, 3)');
      expect(terms[0].termType).toBe('in');
      expect(terms[0].value).toEqual([1, 2, 3]);
    });

    it('should parse not in', () => {
      const terms = parser.parse("status not in ('deleted', 'archived')");
      expect(terms[0].termType).toBe('not-in');
      expect(terms[0].value).toEqual(['deleted', 'archived']);
    });
  });

  describe('between', () => {
    it('should parse between', () => {
      const terms = parser.parse('age between 18 and 65');
      expect(terms[0].termType).toBe('between');
      expect(terms[0].value).toEqual([18, 65]);
    });
  });

  describe('is null / is not null', () => {
    it('should parse is null', () => {
      const terms = parser.parse('email is null');
      expect(terms[0].termType).toBe('is-null');
    });

    it('should parse is not null', () => {
      const terms = parser.parse('email is not null');
      expect(terms[0].termType).toBe('is-not-null');
    });
  });

  describe('AND / OR combinations', () => {
    it('should parse AND conditions', () => {
      const terms = parser.parse("name = 'Alice' and age > 18");
      expect(terms).toHaveLength(2);
      expect(terms[0].type).toBe('and');
      expect(terms[1].type).toBe('and');
    });

    it('should parse OR conditions', () => {
      const terms = parser.parse("status = 'active' or status = 'pending'");
      expect(terms).toHaveLength(2);
      expect(terms[1].type).toBe('or');
    });

    it('should parse mixed AND/OR', () => {
      const terms = parser.parse("a = 1 and b = 2 or c = 3");
      expect(terms).toHaveLength(3);
    });
  });

  describe('nested expressions (parentheses)', () => {
    it('should parse nested expression', () => {
      const terms = parser.parse("(name = 'Alice' or name = 'Bob') and age > 18");
      expect(terms).toHaveLength(2);
      // First term should be a nest
      expect(terms[0].termType).toBe('nest');
      expect(terms[0].terms).toHaveLength(2);
      expect(terms[1].column).toBe('age');
    });
  });

  describe('special values', () => {
    it('should parse null keyword', () => {
      const terms = parser.parse('value = null');
      expect(terms[0].value).toBeNull();
    });

    it('should parse true keyword', () => {
      const terms = parser.parse('active = true');
      expect(terms[0].value).toBe(true);
    });

    it('should parse false keyword', () => {
      const terms = parser.parse('active = false');
      expect(terms[0].value).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should throw for invalid expression', () => {
      expect(() => parser.parse('')).toThrow();
    });

    it('should throw for unexpected character', () => {
      expect(() => parser.parse('field @ value')).toThrow();
    });

    it('should throw for not without in/like', () => {
      expect(() => parser.parse('field not between 1 and 2')).toThrow('Expected "in" or "like"');
    });
  });

  describe('escaped strings', () => {
    it('should parse escaped quotes in strings', () => {
      const terms = parser.parse("name = 'O\\'Brien'");
      expect(terms[0].value).toBe("O'Brien");
    });
  });

  describe('dotted field names', () => {
    it('should parse dotted field names', () => {
      const terms = parser.parse("user.name = 'Alice'");
      expect(terms[0].column).toBe('user.name');
    });
  });
});
