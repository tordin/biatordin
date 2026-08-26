import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { RunnableConfig } from "@langchain/core/runnables";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { safeAgentNode } from "./workspace/base.js";
import { modelFlash as model } from "../llm/model.js";
import { AgentState } from "./state.js";
import { logger } from "../utils/logger.js";
import { getSkill } from "../skills/registry.js";
import {
  saveEntity,
  getEntityById,
  getEntityByNameOrAlias,
  searchEntities,
  saveRelationship,
  getRelationshipsForEntity,
  EntityType,
  CreateEntityDTO
} from "../memory/entities.js";
import { resolveEntity, resolveEntityContext } from "../services/entityResolver.js";

export const saveEntityTool = tool(
  async ({ id, name, type, aliases, contact_jid, phone, email, role_or_relation, preferences, notes }, config) => {
    try {
      let parsedPrefs: Record<string, any> = {};
      if (preferences) {
        if (typeof preferences === 'string') {
          try {
            parsedPrefs = JSON.parse(preferences);
          } catch {
            parsedPrefs = { raw: preferences };
          }
        } else if (typeof preferences === 'object') {
          parsedPrefs = preferences;
        }
      }

      const dto: CreateEntityDTO = {
        id: id || undefined,
        name,
        type: (type as EntityType) || 'person',
        aliases: aliases || undefined,
        contact_jid: contact_jid || undefined,
        phone: phone || undefined,
        email: email || undefined,
        role_or_relation: role_or_relation || undefined,
        preferences: Object.keys(parsedPrefs).length > 0 ? parsedPrefs : undefined,
        notes: notes || undefined
      };

      const entity = await saveEntity(dto);

      return `✅ Entidade salva com sucesso no CRM!\nID: ${entity.id}\nNome: ${entity.name}\nTipo: ${entity.type.toUpperCase()}\nApelidos: ${entity.aliases.join(', ') || 'Nenhum'}\nPapel/Relação: ${entity.role_or_relation || 'Não especificado'}${entity.phone ? `\nTelefone: ${entity.phone}` : ''}${entity.contact_jid ? `\nWhatsApp JID: ${entity.contact_jid}` : ''}${entity.email ? `\nE-mail: ${entity.email}` : ''}${Object.keys(entity.preferences).length > 0 ? `\nPreferências: ${JSON.stringify(entity.preferences)}` : ''}${entity.notes ? `\nNotas: ${entity.notes}` : ''}`;
    } catch (err: any) {
      logger.error("[CRM AGENT] Erro ao salvar entidade:", err);
      return `Erro ao salvar entidade no banco de dados: ${err.message}`;
    }
  },
  {
    name: "save_entity",
    description: "Salva ou atualiza uma entidade (pessoa, empresa/organização, projeto, lugar) no CRM Pessoal da Bia com dados cadastrais, apelidos, telefone, JID, preferências e notas.",
    schema: z.object({
      id: z.number().optional().describe("ID da entidade caso seja uma atualização direta por ID."),
      name: z.string().describe("Nome principal da entidade (ex: 'Luciana', 'Ricardo', 'Reforma Alphaville', 'iFood')."),
      type: z.enum(["person", "organization", "project", "place"]).optional().describe("Tipo da entidade: 'person' (pessoa), 'organization' (empresa/escola/órgão), 'project' (projeto/obra/evento), 'place' (lugar/cidade/bairro). Padrão: 'person'."),
      aliases: z.array(z.string()).optional().describe("Lista de apelidos ou variações de nome (ex: ['Lu', 'Amor', 'Dra. Lu'])."),
      contact_jid: z.string().optional().describe("JID do WhatsApp se conhecido (ex: '5519991377200@s.whatsapp.net')."),
      phone: z.string().optional().describe("Número de telefone (ex: '19991377200' ou '5519991377200')."),
      email: z.string().optional().describe("Endereço de e-mail se disponível."),
      role_or_relation: z.string().optional().describe("Relação com o Luiz ou papel funcional (ex: 'esposa', 'engenheiro', 'pediatra', 'sócio', 'cliente VIP')."),
      preferences: z.record(z.string(), z.any()).optional().describe("Objeto de preferências conhecidas (ex: {\"prefer_audio\": true, \"no_morning_meetings\": true, \"birthday\": \"15/05\"})."),
      notes: z.string().optional().describe("Observações gerais ou contexto sobre a pessoa/projeto.")
    })
  }
);

export const addRelationshipTool = tool(
  async ({ sourceEntity, targetEntity, relationType, contextNotes }, config) => {
    try {
      // 1. Resolve ou cria sourceEntity
      let sourceId: number;
      if (typeof sourceEntity === 'number') {
        sourceId = sourceEntity;
      } else {
        const foundSource = await resolveEntity(sourceEntity);
        if (foundSource) {
          sourceId = foundSource.entity.id;
        } else {
          // Cria entidade padrão
          const created = await saveEntity({ name: sourceEntity, type: 'person' });
          sourceId = created.id;
        }
      }

      // 2. Resolve ou cria targetEntity
      let targetId: number;
      if (typeof targetEntity === 'number') {
        targetId = targetEntity;
      } else {
        const foundTarget = await resolveEntity(targetEntity);
        if (foundTarget) {
          targetId = foundTarget.entity.id;
        } else {
          // Deduce type
          const isProject = /reforma|obra|projeto|construcao|viagem|festa|evento/i.test(targetEntity);
          const isOrg = /empresa|escola|colegio|hospital|clinica|loja|ifood/i.test(targetEntity);
          const entType: EntityType = isProject ? 'project' : isOrg ? 'organization' : 'person';
          const created = await saveEntity({ name: targetEntity, type: entType });
          targetId = created.id;
        }
      }

      const rel = await saveRelationship({
        source_entity_id: sourceId,
        target_entity_id: targetId,
        relation_type: relationType,
        context_notes: contextNotes || null
      });

      const srcEntity = await getEntityById(sourceId);
      const tgtEntity = await getEntityById(targetId);

      return `✅ Vínculo/Relacionamento criado com sucesso no Grafo do CRM!\nID: ${rel.id}\nOrigem: ${srcEntity?.name || sourceId} (${srcEntity?.type})\nRelação: [${rel.relation_type}]\nDestino: ${tgtEntity?.name || targetId} (${tgtEntity?.type})${rel.context_notes ? `\nContexto: ${rel.context_notes}` : ''}`;
    } catch (err: any) {
      logger.error("[CRM AGENT] Erro ao adicionar relacionamento:", err);
      return `Erro ao criar relacionamento no banco de dados: ${err.message}`;
    }
  },
  {
    name: "add_relationship",
    description: "Cria ou atualiza uma conexão direcional entre duas entidades no Grafo de Relacionamentos (ex: Ricardo é engenheiro da Reforma; Dr. Marcos é pediatra do Theo; Luciana é esposa do Luiz).",
    schema: z.object({
      sourceEntity: z.union([z.string(), z.number()]).describe("Nome, apelido ou ID numérico da entidade de origem (ex: 'Ricardo', 'Dr. Marcos', 'Luciana')."),
      targetEntity: z.union([z.string(), z.number()]).describe("Nome, apelido ou ID numérico da entidade de destino (ex: 'Reforma Alphaville', 'Theo', 'Luiz')."),
      relationType: z.string().describe("Tipo padronizado da relação (ex: 'spouse_of', 'works_at', 'engineer_of_project', 'doctor_of', 'parent_of', 'child_of', 'friend_of', 'client_of', 'supplier_of')."),
      contextNotes: z.string().optional().describe("Notas ou detalhes adicionais sobre esse vínculo (ex: 'Engenheiro responsável pelas obras estruturais de Alphaville').")
    })
  }
);

export const getEntityContextTool = tool(
  async ({ query }, config) => {
    try {
      const dossier = await resolveEntityContext(query);
      return `<RAW_TOOL_OUTPUT source="sqlite:entities">\n${dossier}\n</RAW_TOOL_OUTPUT>`;
    } catch (err: any) {
      logger.error("[CRM AGENT] Erro ao buscar contexto da entidade:", err);
      return `Erro ao recuperar contexto da entidade: ${err.message}`;
    }
  },
  {
    name: "get_entity_context",
    description: "Recupera a ficha completa (dossiê) de uma pessoa, empresa ou projeto no CRM, incluindo todos os seus dados cadastrais, preferências de contato e vínculos/conexões no grafo.",
    schema: z.object({
      query: z.string().describe("Nome, apelido, papel ou ID da entidade a consultar (ex: 'Luciana', 'Lu', 'Ricardo', 'engenheiro da obra', 'pediatra do Theo').")
    })
  }
);

export const searchEntitiesTool = tool(
  async ({ query, type }, config) => {
    try {
      const results = await searchEntities(query, type as any);
      if (results.length === 0) {
        return `Nenhuma entidade encontrada no CRM para o termo "${query}".`;
      }

      const formatted = await Promise.all(
        results.slice(0, 15).map(async (e) => {
          const rels = await getRelationshipsForEntity(e.id);
          const relCount = rels.length > 0 ? ` [${rels.length} conexões no grafo]` : '';
          const contact = e.phone || e.contact_jid || e.email || 'sem contato direto';
          const role = e.role_or_relation ? ` | ${e.role_or_relation}` : '';
          return `- [ID ${e.id}] ${e.name} (${e.type.toUpperCase()}${role}) - Contato: ${contact}${relCount}${e.notes ? `\n  Obs: ${e.notes}` : ''}`;
        })
      );

      const extra = results.length > 15 ? `\n...e mais ${results.length - 15} entidades.` : '';

      return `<RAW_TOOL_OUTPUT source="sqlite:entities">\nEntidades encontradas no CRM (${results.length}):\n${formatted.join('\n')}${extra}\n</RAW_TOOL_OUTPUT>`;
    } catch (err: any) {
      logger.error("[CRM AGENT] Erro ao buscar entidades:", err);
      return `Erro ao buscar entidades: ${err.message}`;
    }
  },
  {
    name: "search_entities",
    description: "Busca entidades cadastradas no CRM Pessoal por nome, apelido, cargo/papel, telefone ou anotações.",
    schema: z.object({
      query: z.string().describe("Termo de busca (nome, cargo, apelido, etc)."),
      type: z.enum(["person", "organization", "project", "place", "all"]).optional().describe("Filtro opcional por tipo de entidade. Padrão: 'all'.")
    })
  }
);

const CRM_PROMPT = getSkill("crmAgent")?.detailedPrompt ||
  "Você é o Agente de CRM Pessoal e Grafo de Relacionamentos da Bia.\n" +
  "Sua função é gerenciar entidades (pessoas, empresas, projetos, lugares), preferências e conexões no grafo.\n" +
  "Sempre use as ferramentas apropriadas (`save_entity`, `add_relationship`, `get_entity_context`, `search_entities`) e seja preciso.";

const crmAgent = createReactAgent({
  llm: model,
  tools: [saveEntityTool, addRelationshipTool, getEntityContextTool, searchEntitiesTool],
  messageModifier: CRM_PROMPT,
});

export async function crmAgentNode(state: typeof AgentState.State, config?: RunnableConfig) {
  return safeAgentNode("crmAgent", () => crmAgent, state, undefined, config);
}
