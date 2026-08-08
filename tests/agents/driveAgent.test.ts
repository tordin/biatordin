import { jest, describe, test, expect } from '@jest/globals';
import { driveAgentNode } from '../../src/agents/workspace/drive.js';

describe('Drive Agent Node', () => {
  test('deve inicializar e exportar a função driveAgentNode', () => {
    expect(typeof driveAgentNode).toBe('function');
  });
});
