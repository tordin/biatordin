# AGENTS.md - Diretrizes de Arquitetura & Padrões dos Agentes da Bia

Este documento estabelece as diretrizes arquiteturais, regras de projeto e padrões de design obrigatoriamente seguidos no desenvolvimento e manutenção da assistente virtual **Bia**.

---

## 0. Documentação Arquitetural de Referência (`docs/architecture/`)

O repositório mantém uma pasta modular de documentação técnica e decisões arquiteturais em [`docs/architecture/`](docs/architecture/README.md).

### Diretrizes Obrigatórias para IAs e Desenvolvedores:
1. **Consulta Prévia Obrigatória:** Antes de propor ou implementar alterações estruturais, refatorações, criação de nós no LangGraph, novos agentes especialistas, alterações em tabelas do SQLite ou regras de transporte/memória, a IA **DEVE** consultar o documento correspondente em `docs/architecture/` ou a [Visão Geral Consolidada](docs/architecture/ARQUITETURA_CONSOLIDADA.md):
   - [Documento Único Consolidado](docs/architecture/ARQUITETURA_CONSOLIDADA.md)
   - [01. Visão Geral & Princípios](docs/architecture/01-visao-geral-e-principios.md)
   - [02. Fluxo LangGraph & Estado](docs/architecture/02-fluxo-langgraph-e-estado.md)
   - [03. Supervisora & Cenários](docs/architecture/03-supervisora-e-cenarios.md)
   - [04. Skills & Tools Registry](docs/architecture/04-skills-e-tools-registry.md)
   - [05. Agentes Especialistas](docs/architecture/05-agentes-especialistas.md)
   - [06. Sistema de Memória & RAG](docs/architecture/06-sistema-de-memoria-e-rag.md)
   - [07. CRM Pessoal & Entidades](docs/architecture/07-crm-e-grafo-de-entidades.md)
   - [08. Transporte WhatsApp](docs/architecture/08-transporte-whatsapp-baileys.md)
   - [09. Missões Autônomas](docs/architecture/09-missoes-autonomas.md)
   - [10. Follow-Up & Cobranças](docs/architecture/10-follow-up-e-cobrancas.md)
   - [11. Sentinela de E-mail](docs/architecture/11-sentinela-de-email.md)
   - [12. Avaliação & Segurança](docs/architecture/12-avaliacao-qualidade-e-seguranca.md)
   - [13. Banco de Dados SQLite](docs/architecture/13-banco-de-dados-e-persistencia.md)
   - [14. Observabilidade & Debugger](docs/architecture/14-observabilidade-api-e-debugger.md)
   - [15. Guia de Evolução](docs/architecture/15-guia-de-evolucao-e-manutencao.md)
2. **Sincronização Contínua pós-Modificação:** Sempre que uma funcionalidade, regra de negócio, ferramenta ou estrutura de banco for criada, alterada ou removida:
   - A IA **DEVE** atualizar o(s) documento(s) afetado(s) em `docs/architecture/` no mesmo commit/tarefa.
   - O `AGENTS.md` e o `docs/architecture/README.md` devem ser mantidos coerentes e atualizados como o índice mestre de regras.


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

## 3. Arquitetura de Memória Cognitiva & Armazenamento Dedicado

A memória da Bia é unificada 100% no SQLite (`database.sqlite`) e dividida entre **Memória de Trabalho Cognitiva (RAG)** e **Espaços Operacionais Dedicados**:

### A) Memória de Trabalho Cognitiva (Working Memory & RAG em SQLite)
- **Persistência Unificada:** Armazenada nas tabelas `long_term_memories` e `vec_memories` (3072 dimensões via `sqlite-vec`).
- **Score Contínuo de Ativação & Decay Duplo:** $S(i, t) = I^2 + (1 - I^2) \cdot R(\Delta t) \cdot F(n)$, balanceando **Importância** ($I=1.0$ para fatos vitais de perfil perenes), **Recência** (curva exponencial suave com meia-vida de 7 dias) e **Reforço** (citações e co-ativações). Fatos contextuais/transitórios (`conversa`, `contexto` com $I < 0.85$) possuem **decay duplo de sessão** (meia-vida de 4h) aplicado no componente dinâmico.
- **Retrieval Híbrido com RRF:** `getWorkingMemoryContext()` executa busca combinada por recência/cobertura (Canal A) e busca semântica vetorial no `sqlite-vec` (Canal B), fundidos via **Reciprocal Rank Fusion (RRF)** ($k=60$) com ponderação equilibrada contra o score cognitivo.
- **Sistema de Slots Reservados:** Segmentação estruturada do orçamento de contexto com overflow inteligente entre **Slot Core** (30% - perfil/vitais), **Slot Sessão** (25% - últimas 4h) e **Slot Relevância** (45% - longo prazo/semântica).
- **Reconciliação Semântica na Gravação:** Gravações sensíveis (`perfil`, `fato`, `preferencia`, `combinado`) realizam busca vetorial prévia local e arbitram contradições via `semanticArbiter.ts` (distinção de sujeitos e prevalência de declarações negativas).
- **Injeção em Tempo Real (Pós-Snapshot):** Fatos criados/atualizados após o último snapshot consolidado ou pertencentes à sessão ativa são injetados imediatamente no bloco `## 🔄 Contexto & Fatos Recentes` em `getWorkingMemoryContext()`, sem filtros restritivos de importância.
- **Consolidação de Sono Bidirecional & GC:** Síntese diária às 03:05 via LLM que compila o snapshot e expurga contradições/erros (`purgeIds`) da base relacional, acompanhada do Garbage Collector para descarte de fatos transitórios esquecidos.
- **Documentos Vivos por Contexto (Scoped Living Documents):** Documentos Markdown contínuos na tabela `context_documents` associados a `topicId`. Permitem injeção direta (*Direct Fetch / Zero-RAG*) em rotinas, missões e conversas com tópicos ativos, com compactação semântica síncrona (preservando regras sagradas e arquivando excessos em `long_term_memories`).

### B) Espaços de Armazenamento Operacionais Dedicados (SQLite & `src/memory/db.ts`)
- **Conexão Centralizada Obrigatória:** Todos os módulos de persistência **DEVEM** obter a conexão SQLite exclusivamente através de `getDb()` / `getDbPath()` em `src/memory/db.ts`. NUNCA instancie `new sqlite3.Database('database.sqlite')` diretamente.
- **Isolamento de Testes:** A suíte de testes do Jest roda automaticamente apontando para `database.test.sqlite` via `process.env.SQLITE_DB_PATH`, garantindo que testes automatizados nunca alterem ou poluam a base de produção (`database.sqlite`).
- Dados operacionais dinâmicos devem residir em **tabelas SQLite dedicadas** gerenciadas por suas respectivas Skills/Tools:
  - **Gestão de Tarefas & Listas**: Tabela `tasks` + `taskAgent` (`add_task`, `list_tasks`, `complete_task`, `delete_task`).
  - **Rotinas e Lembretes**: Tabela `routines` + `routineAgent` (`create_routine`, `list_routines`, `delete_routine`).
  - **Documentos Vivos de Contexto**: Tabela `context_documents` + `memoryAgent` (`get_context_document`, `append_context_document`, `overwrite_context_document`, `compact_context_document`).
  - **Missões Autônomas**: Tabela `missions` (com suporte a `topicId`) + `missionAgent`.
  - **CRM Pessoal & Entidades**: Tabelas `entities` e `entity_relationships` + `crmAgent`.
  - **Inventários & Trackers Complexos**: Tabela `trackers` + `trackerAgent` (`create_tracker`, `list_trackers`, `get_tracker`, `update_tracker`, `delete_tracker`).
  - **Sentinela de E-mails**: Tabelas `email_sentinel_rules` e `email_sentinel_log` + `emailSentinelAgent`.
  - **Monitoramento de Grupos & Segurança**: Tabelas `trusted_chats` / `daily_summary_groups` / `topics` + `securityAgent` e `whatsappAgent`.


---

## 4. Padrões de Roteamento & LangGraph

- As transições no fluxo LangGraph em `src/graph/workflow.ts` devem ser declarativas.
- Quando uma nova Skill especialista é criada:
  1. Registrar em `src/skills/registry.ts`.
  2. Implementar a Skill/Node em `src/agents/`.
  3. Adicionar o enum correspondente em `src/agents/supervisor.ts`.
  4. Conectar o nó e as arestas condicionais em `src/graph/workflow.ts`.
  5. Criar testes unitários correspondentes em `tests/`.
- Quando uma Skill é removida, desfazer os 5 passos acima E remover `tests/agents/<skill>.test.ts` se existir.

## 5. Setup de Build e Testes

- **Build:** `npm run build` (executa `tsc`). TypeScript strict mode.
- **Testes:** `npm test` usa `node --experimental-vm-modules node_modules/jest/bin/jest.js` (Jest com ESM).
- `package.json` tem `"type": "module"` — todos os imports usam extensão `.js`.
- Testes que precisam de `DEEPSEEK_API_KEY` ou Google Cloud credentials falham em CI sem essas variáveis de ambiente.

## 6. Roteamento de Cenários e Níveis de Permissão

A Bia opera sob uma **Precedência Estrita de Cenários**, definida na função `buildSupervisorPrompt` (`src/agents/supervisor.ts`). As condições são avaliadas rigorosamente na seguinte ordem (match-and-stop):

1. **[Cenário 3] Conta Pessoal (Passiva)**
   - **Match:** `accountName === 'personal'`
   - **Contexto:** A interação ocorre na conta de WhatsApp pessoal do Luiz (seja 1-a-1 ou grupo).
   - **Atuação:** A Bia atua exclusivamente como **Observadora Passiva** (silenciosa), extraindo memórias e emitindo alertas privados diretamente para o Master em caso de urgência. Nunca responde a terceiros.

*(As regras a seguir aplicam-se exclusivamente quando a conta operante for a principal/Bia)*

2. **[Cenário 1A] Interação Direta com o Criador**
   - **Match:** `isMaster === true`
   - **Contexto:** O Master (Luiz) está falando 1-a-1 ou acionando a Bia.
   - **Atuação:** Acesso **IRRESTRITO** (Nível: `creator`). Pode executar qualquer função, incluindo comandos sensíveis de segurança (como autorizar chats).

3. **[Cenário 1B] Interação 1-1 com Contato Confiável**
   - **Match:** `isTrustedChat === true` E `isGroup === false`
   - **Contexto:** Um contato previamente autorizado está interagindo privadamente com a Bia.
   - **Atuação:** Acesso quase total (Nível: `trusted`), focado em presteza. Funções de sistema/segurança (como gerenciar permissões) são **bloqueadas**.

4. **[Cenário 1C] Interação em Grupo Confiável**
   - **Match:** `isTrustedChat === true` E `isGroup === true`
   - **Contexto:** A Bia foi incluída e autorizada a participar ativamente de um grupo específico.
   - **Atuação:** Nível de acesso `trusted` (sem segurança). Regras de "esperar ser chamada" são aplicadas levemente, focando na utilidade ao objetivo do grupo e intervenções concisas.

5. **[Cenário 2A] Interação 1-1 Não-Confiável (Terceiros / Missões)**
   - **Match:** `isGroup === false` (Caiu no fallback)
   - **Contexto:** Interação direta com terceiros desconhecidos (ex: prestadores de serviço, negociações).
   - **Atuação:** Acesso **RESTRITO** (`restricted`). O objetivo é ser imensamente útil para resolver missões ordenadas pelo Master, porém protegida de "engenharia social" (não entrega dados sensíveis nem atua como assistente geral de estranhos).

6. **[Cenário 2B] Interação em Grupos Não-Confiáveis**
   - **Match:** Sobrou apenas grupos (Caiu no fallback)
   - **Contexto:** Participação em grupos aleatórios na conta da Bia.
   - **Atuação:** Acesso **RESTRITO** (`restricted`). Regras rígidas de "só falar se for chamada". Não oferece serviços e foca exclusivamente em atuar dentro da sandbox de memória do grupo (se solicitada).
