import { jest, describe, test, expect } from '@jest/globals';
import { calendarAgentNode } from '../../src/agents/workspace/calendar.js';

describe('Calendar Agent Node', () => {
  test('deve inicializar e exportar a função calendarAgentNode', () => {
    expect(typeof calendarAgentNode).toBe('function');
  });
});
