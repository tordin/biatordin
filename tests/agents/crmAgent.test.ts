import { describe, test, expect } from '@jest/globals';
import {
  saveEntityTool,
  addRelationshipTool,
  getEntityContextTool,
  searchEntitiesTool,
  crmAgentNode
} from '../../src/agents/crmAgent.js';

describe('CRM Agent Tools & Node Schemas (src/agents/crmAgent.ts)', () => {
  test('deve validar schemas e metadados das ferramentas do CRM', () => {
    expect(saveEntityTool.name).toBe('save_entity');
    expect(addRelationshipTool.name).toBe('add_relationship');
    expect(getEntityContextTool.name).toBe('get_entity_context');
    expect(searchEntitiesTool.name).toBe('search_entities');
  });

  test('crmAgentNode deve estar definido e ser função', () => {
    expect(typeof crmAgentNode).toBe('function');
  });
});
