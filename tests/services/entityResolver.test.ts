import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import {
  initEntitiesTable,
  saveEntity,
  saveRelationship,
  getAllEntities,
  deleteEntity
} from '../../src/memory/entities.js';
import {
  resolveEntity,
  resolveContactJidOrPhone,
  resolveEntityContext,
  normalizeText
} from '../../src/services/entityResolver.js';

describe('Entity Resolver & Knowledge Graph Traversal (src/services/entityResolver.ts)', () => {
  beforeAll(async () => {
    await initEntitiesTable();
  });

  beforeEach(async () => {
    const all = await getAllEntities();
    for (const e of all) {
      await deleteEntity(e.id);
    }
  });

  test('deve normalizar texto removendo acentos e espaços', () => {
    expect(normalizeText('  Lúcia   ')).toBe('lucia');
    expect(normalizeText('Conceição')).toBe('conceicao');
    expect(normalizeText('Dr. Marcos & Cia')).toBe('dr. marcos & cia');
  });

  test('deve resolver menção por apelido exato ("Lu" -> Luciana)', async () => {
    await saveEntity({
      name: 'Luciana',
      type: 'person',
      aliases: ['Lu', 'Amor'],
      phone: '19991377200',
      contact_jid: '5519991377200@s.whatsapp.net',
      role_or_relation: 'esposa',
      preferences: { prefer_audio: true, no_morning_meetings: true }
    });

    const match = await resolveEntity('Lu');
    expect(match).not.toBeNull();
    expect(match?.entity.name).toBe('Luciana');
    expect(match?.score).toBe(1.0);
  });

  test('deve resolver menção por papel ou relação com o Luiz ("esposa" -> Luciana)', async () => {
    await saveEntity({
      name: 'Luciana',
      aliases: ['Lu'],
      role_or_relation: 'esposa'
    });

    const match = await resolveEntity('minha esposa');
    expect(match).not.toBeNull();
    expect(match?.entity.name).toBe('Luciana');
    expect(match?.score).toBeGreaterThanOrEqual(0.9);
  });

  test('deve resolver menção por travessia no grafo ("engenheiro da obra / reforma" -> Ricardo)', async () => {
    const ricardo = await saveEntity({
      name: 'Ricardo',
      type: 'person',
      phone: '19999999999',
      role_or_relation: 'engenheiro'
    });

    const reforma = await saveEntity({
      name: 'Reforma da Casa',
      type: 'project',
      aliases: ['Obra', 'Reforma']
    });

    await saveRelationship({
      source_entity_id: ricardo.id,
      target_entity_id: reforma.id,
      relation_type: 'engineer_of_project',
      context_notes: 'Engenheiro responsável pela reforma'
    });

    const matchReforma = await resolveEntity('engenheiro da reforma');
    expect(matchReforma).not.toBeNull();
    expect(matchReforma?.entity.name).toBe('Ricardo');

    const matchObra = await resolveEntity('fale com o engenheiro da obra');
    expect(matchObra).not.toBeNull();
    expect(matchObra?.entity.name).toBe('Ricardo');
  });

  test('deve resolver menção médica / dependente ("pediatra do Theo" -> Dr. Marcos)', async () => {
    const doctor = await saveEntity({
      name: 'Dr. Marcos',
      type: 'person',
      phone: '19988776655',
      role_or_relation: 'pediatra'
    });

    const theo = await saveEntity({
      name: 'Theo',
      type: 'person',
      role_or_relation: 'filho'
    });

    await saveRelationship({
      source_entity_id: doctor.id,
      target_entity_id: theo.id,
      relation_type: 'doctor_of',
      context_notes: 'Pediatra do Theo desde o nascimento'
    });

    const match = await resolveEntity('pediatra do Theo');
    expect(match).not.toBeNull();
    expect(match?.entity.name).toBe('Dr. Marcos');
    expect(match?.entity.phone).toBe('5519988776655');
  });

  test('resolveContactJidOrPhone deve retornar dados de contato e preferências consolidadas', async () => {
    await saveEntity({
      name: 'Luciana',
      aliases: ['Lu'],
      phone: '19991377200',
      contact_jid: '5519991377200@s.whatsapp.net',
      role_or_relation: 'esposa',
      preferences: { prefer_audio: true, birthday: '15/05' }
    });

    const contact = await resolveContactJidOrPhone('Lu');
    expect(contact).not.toBeNull();
    expect(contact?.name).toBe('Luciana');
    expect(contact?.jid).toBe('5519991377200@s.whatsapp.net');
    expect(contact?.phone).toBe('5519991377200');
    expect(contact?.preferences).toEqual({ prefer_audio: true, birthday: '15/05' });
  });

  test('resolveEntityContext deve gerar o dossiê textual formatado para o LLM', async () => {
    const ricardo = await saveEntity({
      name: 'Ricardo',
      type: 'person',
      aliases: ['Ricardinho'],
      phone: '19999999999',
      role_or_relation: 'engenheiro',
      preferences: { prefer_audio: true },
      notes: 'Engenheiro de confiança'
    });

    const reforma = await saveEntity({
      name: 'Reforma Alphaville',
      type: 'project'
    });

    await saveRelationship({
      source_entity_id: ricardo.id,
      target_entity_id: reforma.id,
      relation_type: 'engineer_of_project',
      context_notes: 'Obras estruturais'
    });

    const context = await resolveEntityContext('Ricardo');
    expect(context).toContain('Ficha de Entidade: Ricardo (PERSON)');
    expect(context).toContain('Ricardinho');
    expect(context).toContain('5519999999999');
    expect(context).toContain('prefer_audio');
    expect(context).toContain('engineer_of_project');
    expect(context).toContain('Reforma Alphaville');
  });
});
