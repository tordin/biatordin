import { describe, test, expect, beforeAll, beforeEach } from '@jest/globals';
import {
  initEntitiesTable,
  saveEntity,
  updateEntity,
  getEntityById,
  getEntityByNameOrAlias,
  getEntityByPhone,
  getEntityByJid,
  searchEntities,
  deleteEntity,
  getAllEntities,
  saveRelationship,
  getRelationshipById,
  getRelationshipsForEntity,
  findRelationship,
  deleteRelationship
} from '../../src/memory/entities.js';

describe('Entities & Relationships SQLite DAL (src/memory/entities.ts)', () => {
  beforeAll(async () => {
    await initEntitiesTable();
  });

  beforeEach(async () => {
    const all = await getAllEntities();
    for (const e of all) {
      await deleteEntity(e.id);
    }
  });

  test('deve criar uma nova entidade pessoa com apelidos e preferências', async () => {
    const entity = await saveEntity({
      name: 'Luciana',
      type: 'person',
      aliases: ['Lu', 'Amor'],
      phone: '19991377200',
      contact_jid: '5519991377200@s.whatsapp.net',
      role_or_relation: 'esposa',
      preferences: { prefer_audio: true, no_morning_meetings: true, birthday: '15/05' },
      notes: 'Dentista, esposa do Luiz'
    });

    expect(entity.id).toBeDefined();
    expect(entity.name).toBe('Luciana');
    expect(entity.type).toBe('person');
    expect(entity.aliases).toEqual(['Lu', 'Amor']);
    expect(entity.phone).toBe('5519991377200');
    expect(entity.role_or_relation).toBe('esposa');
    expect(entity.preferences).toEqual({ prefer_audio: true, no_morning_meetings: true, birthday: '15/05' });
    expect(entity.notes).toBe('Dentista, esposa do Luiz');
  });

  test('deve fazer upsert e mesclar apelidos e preferências ao salvar entidade com mesmo nome', async () => {
    await saveEntity({
      name: 'Luciana',
      aliases: ['Lu'],
      preferences: { prefer_audio: true }
    });

    const updated = await saveEntity({
      name: 'Luciana',
      aliases: ['Amor', 'Dra. Lu'],
      phone: '19991377200',
      preferences: { no_morning_meetings: true }
    });

    expect(updated.name).toBe('Luciana');
    expect(updated.aliases).toContain('Lu');
    expect(updated.aliases).toContain('Amor');
    expect(updated.aliases).toContain('Dra. Lu');
    expect(updated.phone).toBe('5519991377200');
    expect(updated.preferences).toEqual({ prefer_audio: true, no_morning_meetings: true });
  });

  test('deve buscar entidade por apelido no getEntityByNameOrAlias', async () => {
    await saveEntity({
      name: 'Luciana',
      aliases: ['Lu', 'Amor']
    });

    const byName = await getEntityByNameOrAlias('Luciana');
    expect(byName).toBeDefined();
    expect(byName?.name).toBe('Luciana');

    const byAlias = await getEntityByNameOrAlias('Lu');
    expect(byAlias).toBeDefined();
    expect(byAlias?.name).toBe('Luciana');

    const byAliasCaseInsensitive = await getEntityByNameOrAlias('amor');
    expect(byAliasCaseInsensitive).toBeDefined();
    expect(byAliasCaseInsensitive?.name).toBe('Luciana');
  });

  test('deve buscar entidade por telefone normalizado e JID equivalente', async () => {
    await saveEntity({
      name: 'Ricardo',
      phone: '19988887777',
      contact_jid: '5519988887777@s.whatsapp.net',
      role_or_relation: 'engenheiro'
    });

    const byPhone = await getEntityByPhone('19988887777');
    expect(byPhone).toBeDefined();
    expect(byPhone?.name).toBe('Ricardo');

    const byJid = await getEntityByJid('5519988887777@s.whatsapp.net');
    expect(byJid).toBeDefined();
    expect(byJid?.name).toBe('Ricardo');
  });

  test('deve realizar busca textual ampla em searchEntities', async () => {
    await saveEntity({
      name: 'Dr. Marcos',
      role_or_relation: 'pediatra',
      notes: 'Pediatra das crianças no consultório Cambuí'
    });

    await saveEntity({
      name: 'Reforma Alphaville',
      type: 'project',
      notes: 'Obra estrutural da casa'
    });

    const searchPediatra = await searchEntities('pediatra');
    expect(searchPediatra.length).toBe(1);
    expect(searchPediatra[0].name).toBe('Dr. Marcos');

    const searchCambuí = await searchEntities('Cambuí');
    expect(searchCambuí.length).toBe(1);
    expect(searchCambuí[0].name).toBe('Dr. Marcos');

    const searchProject = await searchEntities('obra', 'project');
    expect(searchProject.length).toBe(1);
    expect(searchProject[0].name).toBe('Reforma Alphaville');
  });

  test('deve criar e recuperar relacionamentos no grafo com hidratação de entidades', async () => {
    const ricardo = await saveEntity({ name: 'Ricardo', role_or_relation: 'engenheiro' });
    const reforma = await saveEntity({ name: 'Reforma Alphaville', type: 'project' });

    const rel = await saveRelationship({
      source_entity_id: ricardo.id,
      target_entity_id: reforma.id,
      relation_type: 'engineer_of_project',
      context_notes: 'Responsável pela alvenaria e fundação'
    });

    expect(rel.id).toBeDefined();
    expect(rel.relation_type).toBe('engineer_of_project');
    expect(rel.source_entity?.name).toBe('Ricardo');
    expect(rel.target_entity?.name).toBe('Reforma Alphaville');

    const ricardoRels = await getRelationshipsForEntity(ricardo.id, 'outgoing');
    expect(ricardoRels.length).toBe(1);
    expect(ricardoRels[0].target_entity?.name).toBe('Reforma Alphaville');

    const reformaRels = await getRelationshipsForEntity(reforma.id, 'incoming');
    expect(reformaRels.length).toBe(1);
    expect(reformaRels[0].source_entity?.name).toBe('Ricardo');
  });

  test('deve excluir relacionamentos em cascata quando a entidade for deletada', async () => {
    const doctor = await saveEntity({ name: 'Dr. Marcos', role_or_relation: 'pediatra' });
    const child = await saveEntity({ name: 'Theo', role_or_relation: 'filho' });

    await saveRelationship({
      source_entity_id: doctor.id,
      target_entity_id: child.id,
      relation_type: 'doctor_of'
    });

    const relsBefore = await getRelationshipsForEntity(doctor.id);
    expect(relsBefore.length).toBe(1);

    await deleteEntity(doctor.id);

    const relsAfter = await getRelationshipsForEntity(child.id);
    expect(relsAfter.length).toBe(0);
  });
});
