/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { jsonToMarkdown, safeJsonToMarkdown } from './markdownUtils.js';

describe('markdownUtils', () => {
  describe('jsonToMarkdown', () => {
    it('should handle primitives', () => {
      expect(jsonToMarkdown('hello')).toBe('hello');
      expect(jsonToMarkdown(123)).toBe('123');
      expect(jsonToMarkdown(true)).toBe('true');
      expect(jsonToMarkdown(null)).toBe('null');
      expect(jsonToMarkdown(undefined)).toBe('undefined');
    });

    it('should handle simple arrays', () => {
      const data = ['a', 'b', 'c'];
      expect(jsonToMarkdown(data)).toBe('- a\n- b\n- c');
    });

    it('should handle simple objects', () => {
      const data = { name: 'Alice', age: 30 };
      expect(jsonToMarkdown(data)).toBe('- **name**: Alice\n- **age**: 30');
    });

    it('should handle empty structures', () => {
      expect(jsonToMarkdown([])).toBe('[]');
      expect(jsonToMarkdown({})).toBe('{}');
    });

    it('should handle nested structures', () => {
      const data = {
        user: {
          name: 'Bob',
          roles: ['admin', 'user'],
        },
        active: true,
      };
      const result = jsonToMarkdown(data);
      expect(result).toContain('- **user**:');
      expect(result).toContain('  - **name**: Bob');
      expect(result).toContain('  - **roles**:');
      expect(result).toContain('    - admin');
      expect(result).toContain('    - user');
      expect(result).toContain('- **active**: true');
    });

    it('should render tables for arrays of similar objects', () => {
      const data = [
        { id: 1, name: 'Item 1' },
        { id: 2, name: 'Item 2' },
      ];
      const result = jsonToMarkdown(data);
      expect(result).toBe(
        '| id | name |\n| --- | --- |\n| 1 | Item 1 |\n| 2 | Item 2 |',
      );
    });

    it('should handle pipe characters and newlines in table data', () => {
      const data = [{ col1: 'val|ue', col2: 'line\nbreak' }];
      const result = jsonToMarkdown(data);
      expect(result).toBe(
        '| col1 | col2 |\n| --- | --- |\n| val\\|ue | line break |',
      );
    });

    it('should fallback to lists for arrays with mixed objects', () => {
      const data = [
        { id: 1, name: 'Item 1' },
        { id: 2, somethingElse: 'Item 2' },
      ];
      const result = jsonToMarkdown(data);
      expect(result).toContain('- **id**: 1');
      expect(result).toContain('- **somethingElse**: Item 2');
    });
  });

  describe('safeJsonToMarkdown', () => {
    it('should convert valid JSON', () => {
      const json = JSON.stringify({ key: 'value' });
      expect(safeJsonToMarkdown(json)).toBe('- **key**: value');
    });

    it('should return original string for invalid JSON', () => {
      const notJson = 'Not a JSON string';
      expect(safeJsonToMarkdown(notJson)).toBe(notJson);
    });

    it('should handle plain strings that look like numbers or booleans but are valid JSON', () => {
      expect(safeJsonToMarkdown('123')).toBe('123');
      expect(safeJsonToMarkdown('true')).toBe('true');
    });
  });
});
