# 04. Skills & Tools Registry

O **Skills Registry** ([`src/skills/registry.ts`](../../src/skills/registry.ts)) é a **fonte única de verdade** para todas as habilidades e ferramentas executáveis da Bia.

---

## ⚖️ A Distinção Arquitetural: Tool vs. Skill

- **Tool (Ferramenta):** Uma função atômica, programática e tipada via Zod Schema com handler de execução direta. Exemplo: `add_task`, `google_search`, `get_weather`, `save_entity`.
- **Skill (Habilidade / Especialista):** Um módulo funcional de alto nível que combina:
  1. **Prompt de Detalhamento (`detailedPrompt`):** Persona do especialista, diretrizes de raciocínio e heurísticas de negócio.
  2. **Conjunto de Tools Executáveis (`tools`):** Lista de ferramentas que este especialista tem autorização para invocar.
  3. **Regras de Acesso (`requiresTrusted`, `requiresCreator`):** Restrições de segurança por nível de privilégio.

---

## 📋 Estrutura da Interface `SkillDefinition`

Definida em [`src/skills/types.ts`](../../src/skills/types.ts):

```typescript
export type SkillCategory = 'search' | 'workspace' | 'memory' | 'system' | 'shopping' | 'communication' | 'reasoning';

export interface SkillDefinition {
  id: string;                      // Identificador único (ex: 'searchAgent', 'crmAgent')
  name: string;                    // Nome amigável do especialista
  summary: string;                 // Resumo conciso de uma linha (injetado na Supervisora)
  category: SkillCategory;         // Categoria de domínio
  tools: string[];                 // Ferramentas executáveis associadas
  detailedPrompt: string;          // Prompt completo consumido pelo especialista
  requiresTrusted?: boolean;       // Bloqueado para chats restritos/terceiros
  requiresCreator?: boolean;       // Exclusivo para o criador (Luiz / Master)
}
```

---

## 🗂️ Catálogo Atual de Skills do Sistema

| ID da Skill | Categoria | Permissão | Resumo de Atuação | Ferramentas |
|---|---|---|---|---|
| `searchAgent` | `search` | Qualquer | Pesquisas na web, fatos atuais, cotações e leitura de páginas. | `google_search`, `open_webpage` |
| `missionAgent` | `communication` | Qualquer | Gerencia conversas e negociações autônomas com terceiros no WhatsApp. | `start_mission`, `list_missions`, `complete_mission`, `update_mission_notes`, `send_message_to_target`, `notify_master` |
| `calendarAgent` | `workspace` | `trusted` | Leitura, agendamento e criação de eventos no Google Calendar. | Ferramentas Google Workspace MCP |
| `gmailAgent` | `workspace` | `trusted` | Leitura, busca, resposta e envio de e-mails via Gmail. | Ferramentas Google Workspace MCP |
| `emailSentinelAgent` | `workspace` | `creator` | Gestão de regras do sentinela de e-mail, prioridades e varreduras. | `add_sentinel_rule`, `list_sentinel_rules`, `delete_sentinel_rule`, `check_inbox_now`, `get_sentinel_logs`, `check_google_auth_status` |
| `sheetsAgent` | `workspace` | `trusted` | Leitura, listagem e edição de Google Planilhas. | `drive_list_files`, `drive_search_files` |
| `docsAgent` | `workspace` | `trusted` | Criação e leitura de Google Docs. | `drive_list_files`, `drive_search_files`, `drive_read_file` |
| `driveAgent` | `workspace` | `trusted` | Busca, leitura de arquivos e criação de pastas no Google Drive. | `drive_list_files`, `drive_search_files`, `drive_read_file`, `drive_create_folder`, `drive_upload_file`, `drive_share_file` |
| `routineAgent` | `system` | Qualquer | Agendamentos, lembretes e rotinas periódicas via Cron. | `create_routine`, `update_routine`, `list_routines`, `delete_routine` |
| `memoryAgent` | `memory` | Qualquer | Memória cognitiva RAG, Documentos Vivos de Contexto (`context_documents`), gravação de combinados, preferências e perfil. | `readMemory`, `consolidateMemory`, `deleteSemanticMemory`, `searchSemanticMemory`, `storeSemanticMemory`, `searchEventSummary`, `get_context_document`, `append_context_document`, `overwrite_context_document`, `compact_context_document` |
| `taskAgent` | `memory` | Qualquer | Gestão de tarefas, listas de afazeres e checklists operacionais. | `add_task`, `list_tasks`, `complete_task`, `delete_task` |
| `trackerAgent` | `memory` | Qualquer | Gerenciamento de inventários complexos em JSON (planos de manutenção, despensas). | `create_tracker`, `list_trackers`, `get_tracker`, `update_tracker`, `delete_tracker` |
| `securityAgent` | `system` | `creator` | Permissões de chats, conexão de contas WhatsApp e grupos ignorados. | `add_trusted_chat`, `remove_trusted_chat`, `check_trust`, `list_trusted_chats`, `get_master_info`, `connect_personal_account`, `disconnect_personal_account`, `check_personal_account_status`, `ignore_group`, `unignore_group`, `list_ignored_groups` |
| `shoppingAgent` | `shopping` | Qualquer | Busca de produtos e cotações de preços em e-commerces nacionais. | `google_shopping` |
| `whatsappAgent` | `communication` | `trusted` | Histórico local de mensagens, busca de JIDs e resumos de grupos. | `listRecentChats`, `getChatHistory`, `searchChatByName`, `searchGroups`, `generate_daily_summary`, `add_daily_summary_group`, `remove_daily_summary_group`, `list_daily_summary_groups` |
| `reasoningAgent` | `reasoning` | Qualquer | Raciocínio lógico complexo, matemática e análise profunda (DeepSeek Pro Thinking). | *(Sem ferramentas - Thinking mode)* |
| `weatherAgent` | `search` | Qualquer | Consulta de previsão do tempo e condições meteorológicas via OpenMeteo. | `get_weather` |
| `followUpAgent` | `communication` | `trusted` | Rastreamento de cobranças pendentes e promessas assumidas. | `add_follow_up`, `list_follow_ups`, `resolve_follow_up`, `cancel_follow_up`, `update_follow_up` |
| `crmAgent` | `memory` | Qualquer | Grafo de entidades (pessoas, empresas, projetos, apelidos, conexões). | `save_entity`, `add_relationship`, `get_entity_context`, `search_entities` |

---

## 🔍 Geração Dinâmica do Catálogo

A função `getSkillCatalogSummary(accessLevel)` filtra em tempo real as habilidades permitidas para o nível atual do remetente:
- **`creator`:** Retorna todas as 19 skills.
- **`trusted`:** Retorna todas as skills, exceto aquelas com `requiresCreator: true` (ex: `securityAgent`, `emailSentinelAgent`).
- **`restricted`:** Retorna apenas skills públicas e seguras (sem acesso a dados pessoais do Workspace ou segurança).

---

## 🔗 Próximos Passos & Documentos Relacionados

- Para entender a implementação e execução segura de cada especialista:  
  👉 [05. Agentes Especialistas](05-agentes-especialistas.md)
- Para o passo a passo de como criar uma nova Skill:  
  👉 [15. Guia de Evolução & Manutenção](15-guia-de-evolucao-e-manutencao.md)
