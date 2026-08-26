import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import {
  initEntitiesTable,
  getAllEntities,
  deleteEntity
} from '../../src/memory/entities.js';
import {
  saveEntityTool,
  addRelationshipTool,
  getEntityContextTool,
  searchEntitiesTool
} from '../../src/agents/crmAgent.js';

describe('CRM Agent Tools (src/agents/crmAgent.ts)', () => {
  beforeAll(async () => {
    await initEntitiesTable();
  });

  beforeEach(async () => {
    const all = await getAllEntities();
    for (const e of all) {
      await deleteEntity(e.id);
    }
  });

  test('save_entity tool deve criar uma nova entidade pessoa com preferências', async () => {
    const result = await (saveEntityTool as any).invoke({
      name: 'Luciana',
      type: 'person',
      aliases: ['Lu', 'Amor'],
      phone: '19991377200',
      contact_jid: '5519991377200@s.whatsapp.net',
      role_or_relation: 'esposa',
      preferences: { prefer_audio: true, no_morning_meetings: true },
      notes: 'Dentista'
    });

    expect(result).toContain('Entidade salva com sucesso no CRM');
    expect(result).toContain('Luciana');
    expect(result).toContain('Lu, Amor');
    expect(result).toContain('5519991377200');
    expect(result).toContain('prefer_audio');
  });

  test('add_relationship tool deve conectar duas entidades pelo nome', async () => {
    // 1. Cria Ricardo
    await (saveEntityTool as any).invoke({
      name: 'Ricardo',
      type: 'person',
      phone: '19999999999',
      role_or_relation: 'engenheiro'
    });

    // 2. Conecta Ricardo à Reforma da Casa (criando o projeto automaticamente se não existir)
    const relResult = await (addRelationshipTool as any).invoke({
      sourceEntity: 'Ricardo',
      targetEntity: 'Reforma Alphaville',
      relationType: 'engineer_of_project',
      contextNotes: 'Responsável técnico das obras'
    });

    expect(relResult).toContain('Vínculo/Relacionamento criado com sucesso no Grafo do CRM');
    expect(relResult).toContain('Ricardo (person)');
    expect(relResult).toContain('[engineer_of_project]');
    expect(relResult).toContain('Reforma Alphaville (project)');
    expect(relResult).toContain('Responsável técnico das obras');
  });

  test('get_entity_context tool deve retornar dossiê completo da entidade e suas conexões', async () => {
    // Cria médico e paciente
    await (saveEntityTool as any).invoke({
      name: 'Dr. Marcos',
      type: 'person',
      phone: '19988776655',
      role_or_relation: 'pediatra',
      notes: 'Atende no Cambuí'
    });

    await (saveEntityTool as any).invoke({
      name: 'Theo',
      type: 'person',
      role_or_relation: 'filho'
    });

    await (addRelationshipTool as any).invoke({
      sourceEntity: 'Dr. Marcos',
      targetEntity: 'Theo',
      relationType: 'doctor_of',
      contextNotes: 'Pediatra de confiança'
    });

    const context = await (getEntityContextTool as any).invoke({
      query: 'Dr. Marcos'
    });

    expect(context).toContain('<RAW_TOOL_OUTPUT source="sqlite:entities">');
    expect(context).toContain('Ficha de Entidade: Dr. Marcos (PERSON)');
    expect(context).toContain('5519988776655');
    expect(context).toContain('doctor_of');
    expect(context).toContain('Theo');
  });

  test('search_entities tool deve listar entidades que casem com termo de busca', async () => {
    await (saveEntityTool as any).invoke({
      name: 'Luciana',
      aliases: ['Lu'],
      role_or_relation: 'esposa'
    });

    await (saveEntityTool as any).invoke({
      name: 'Ricardo',
      role_or_relation: 'engenheiro'
    });

    const searchResult = await (searchEntitiesTool as any).invoke({
      query: 'engenheiro'
    });

    expect(searchResult).toContain('<RAW_TOOL_OUTPUT source="sqlite:entities">');
    expect(searchResult).toContain('Ricardo');
    expect(searchResult).not.toContain('Luciana');
  });
});
