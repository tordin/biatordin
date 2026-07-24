# AGENTS.md - Diretrizes de Arquitetura & Padrões dos Agentes da Bia

Este documento estabelece as diretrizes arquiteturais, regras de projeto e padrões de design obrigatoriamente seguidos no desenvolvimento e manutenção da assistente virtual **Bia**.

---

## 1. Arquitetura de Tools vs. Skills

O sistema utiliza a distinção clara entre **Tools (Ferramentas)** e **Skills (Habilidades)**:

- **Tool (Ferramenta)**: Função atômica e programaticamente executável (com schema de entrada e handler em código TS/JS). Ex: `google_search`, `add_task`, `add_calendar_event`.
- **Skill (Habilidade / Especialista)**: Módulo funcional de alto nível que combina um **Prompt de Detalhamento** (persona, regras operacionais e de negócio do especialista) com um conjunto de **Tools executáveis**.

### Centralização no Skills Registry (`src/skills/`)
- Toda Skill/Ferramenta do sistema **deve ser cadastrada** em `src/skills/registry.ts` com a interface `SkillDefinition` (`id`, `name`, `summary`, `detailedPrompt`, `category`).
- `src/skills/registry.ts` é a **fonte única de verdade** para resumos e prompts de detalhamento dos especialistas.

---

## 2. Prevenção de Inchaço de Prompt (Context Bloat Prevention)

Para manter a eficiência de tokens, baixa latência e alta precisão do LLM:

1. **Catálogo Resumido na Supervisora (Bia)**:
   - O `SUPERVISOR_PROMPT` em `src/agents/supervisor.ts` enxerga **apenas a lista resumida de habilidades** gerada dinamicamente via `getSkillCatalogSummary()`.
   - **Regra:** NUNCA adicione parágrafos longos com descrições detalhadas de especialistas dentro do System Prompt da Supervisora.

2. **Prompts de Detalhamento Modulares**:
   - Cada agente especialista (ex: `searchAgent`, `taskAgent`, `routineAgent`, `memoryAgent`, `securityAgent`, etc.) consome seu próprio `detailedPrompt` vindo do Skills Registry apenas quando é executado.

---

## 3. Arquitetura de Memória & Armazenamento Dedicado

A memória da Bia é dividida rigorosamente entre **Memória de Perfil (Core)** e **Espaços Operacionais Dedicados**:

### A) Memória Core (`data/bia_memory.md`)
- Contém **exclusivamente informações de perfil e fatos permanentes/semi-permanentes** do usuário e sua família (nome, idade, familiares, hobbies, preferências, contextos de vida).
- É injetada no contexto da Supervisora para personalizar a interação.
- **Regra:** NUNCA grave tarefas, listas de afazeres, itens a vender, histórico de preços ou configurações temporárias no arquivo `bia_memory.md`.

### B) Espaços de Armazenamento Operacionais Dedicados (SQLite)
- Dados operacionais dinâmicos devem obrigatoriamente residir em **tabelas SQLite dedicadas** (`database.sqlite`) geridas por suas respectivas Skills/Tools:
  - **Gestão de Tarefas & Listas**: Tabela `tasks` + `taskAgent` (`add_task`, `list_tasks`, `complete_task`, `delete_task`).
  - **Rotinas e Lembretes**: Tabela `routines` + `routineAgent` (`create_routine`, `list_routines`, `delete_routine`).
  - **Monitoramento de Grupos & Segurança**: Tabelas `security` / `ignored_groups` / `topics` + `securityAgent` e `whatsappAgent`.

---

## 4. Padrões de Roteamento & LangGraph

- As transições no fluxo LangGraph em `src/graph/workflow.ts` devem ser declarativas.
- Quando uma nova Skill especialista é criada:
  1. Registrar em `src/skills/registry.ts`.
  2. Implementar a Skill/Node em `src/agents/`.
  3. Adicionar o enum correspondente em `src/agents/supervisor.ts`.
  4. Conectar o nó e as arestas condicionais em `src/graph/workflow.ts`.
  5. Criar testes unitários correspondentes em `tests/`.
