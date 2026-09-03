# Arquitetura e Decisões de Projeto da Bia

Bem-vindo à documentação arquitetural da **Bia**, a assistente virtual e executiva pessoal autônoma que opera no WhatsApp.

Este diretório contém as **Decisões Arquiteturais de Registro (ADRs)**, padrões estruturais, fluxos de dados e especificações técnicas de cada subsistema do projeto.

> [!TIP]
> **Documento Consolidado:** Para uma visão geral técnica completa de ponta a ponta em um arquivo único — cobrindo com profundidade especial o fluxo da **Supervisora** e do **Evaluator** —, consulte:  
> 👉 [**Visão Geral Consolidada da Arquitetura da Bia**](ARQUITETURA_CONSOLIDADA.md)

---

## 🗺️ Mapa de Navegação da Arquitetura

A documentação está organizada de forma hierárquica, descendo do nível **Macro** (visão geral, princípios e grafo de orquestração) para o nível **Micro** (especificação detalhada de subsistemas, memórias, segurança e transporte).

| # | Documento | Descrição & Escopo | Principais Módulos de Código |
|---|---|---|---|
| **01** | [Visão Geral & Princípios](01-visao-geral-e-principios.md) | Propósito da Bia, personas, modelo mental e princípios de design | `src/index.ts`, `AGENTS.md` |
| **02** | [Fluxo LangGraph & Estado Compartilhado](02-fluxo-langgraph-e-estado.md) | Orquestração do grafo, nós, arestas condicionais e `AgentState` | `src/graph/workflow.ts`, `src/agents/state.ts` |
| **03** | [Supervisora & Precedência de Cenários](03-supervisora-e-cenarios.md) | O cérebro roteador, árvore de cenários de acesso e prompt dinâmico | `src/agents/supervisor.ts` |
| **04** | [Skills & Tools Registry](04-skills-e-tools-registry.md) | Padrão Skills vs Tools, catálogo dinâmico e níveis de permissão | `src/skills/registry.ts`, `src/skills/types.ts` |
| **05** | [Agentes Especialistas](05-agentes-especialistas.md) | Detalhamento dos 19 agentes, `safeAgentNode` e proteção contra loops | `src/agents/*`, `src/agents/workspace/*` |
| **06** | [Sistema de Memória & RAG Híbrido](06-sistema-de-memoria-e-rag.md) | Memória de Trabalho Cognitiva, Documentos Vivos por Contexto, RAG Vetorial (`sqlite-vec`) e Tópicos | `src/memory/workingMemory.ts`, `src/memory/vectorMemory.ts`, `src/memory/contextDocuments.ts` |
| **07** | [CRM Pessoal & Grafo de Entidades](07-crm-e-grafo-de-entidades.md) | Grafo de conhecimento de pessoas, projetos, apelidos e resolução de JIDs | `src/memory/entities.ts`, `src/services/entityResolver.ts` |
| **08** | [Transporte WhatsApp & Mensageria](08-transporte-whatsapp-baileys.md) | Multi-contas Baileys (`main`/`personal`), Command Router, debounce e áudio | `src/transport/whatsapp.ts`, `src/commands/commandRouter.ts` |
| **09** | [Missões Autônomas com Terceiros](09-missoes-autonomas.md) | Negociação autônoma via WhatsApp, TTL, living documents e resolução de LID | `src/memory/missions.ts`, `src/agents/missionAgent.ts` |
| **10** | [Follow-Up & Cobranças](10-follow-up-e-cobrancas.md) | Motor de cobranças (`waiting_for_them` e `promised_by_me`) e worker cron | `src/memory/followUps.ts`, `src/services/followUp/*` |
| **11** | [Sentinela de E-mails do Gmail](11-sentinela-de-email.md) | Varredura contínua de inbox, filtro heurístico e regras de descarte | `src/services/emailSentinel/*`, `src/agents/emailSentinelAgent.ts` |
| **12** | [Avaliação de Qualidade & Segurança](12-avaliacao-qualidade-e-seguranca.md) | Nó `evaluator`, groundedness audit, `outputGateway` e tool seals | `src/agents/evaluator.ts`, `src/agents/outputGateway.ts` |
| **13** | [Banco de Dados & Persistência](13-banco-de-dados-e-persistencia.md) | Catálogo de tabelas SQLite, índices, checkpointer e rotinas de manutenção | `database.sqlite`, `src/memory/db.ts`, `src/utils/maintenance.ts` |
| **14** | [Observabilidade, API & Debugger](14-observabilidade-api-e-debugger.md) | Logging estruturado JSONL, SSE endpoint e frontend `bia-debugger` | `src/utils/logger.ts`, `src/api/server.ts`, `bia-debugger/` |
| **15** | [Guia de Evolução & Manutenção](15-guia-de-evolucao-e-manutencao.md) | Protocolo prático para IAs e humanos adicionarem novas funcionalidades | `tests/`, `AGENTS.md` |

---

## 🏛️ Diagrama Macro da Arquitetura

```mermaid
flowchart TB
    subgraph INGRESS["Camada de Entrada (Ingress & Transport)"]
        WA_MAIN["WhatsApp Conta Principal (Bia)"]
        WA_PERS["WhatsApp Conta Pessoal (Passiva)"]
        VOICE["Transcrição de Áudio (Groq Whisper)"]
        QUEUE["Fila com Debounce & Silêncio (chatQueues)"]
        CMD_ROUTER{"Command Router<br/>Comandos / ou !"}
    end

    subgraph LANGGRAPH["Orquestração LangGraph (workflow.ts)"]
        CHECKPOINT[("SqliteSaver Checkpointer")]
        SUMMARIZER["Summarizer (Compactação de Histórico)"]
        SUPERVISOR{"Supervisora Central (Bia)"}
        SPECIALISTS["Agentes Especialistas (19 Habilidades)"]
        EVALUATOR{"Avaliador de Qualidade (Critic/Auditor)"}
        GATEWAY["Output Gateway (Disparo Out-of-band)"]
    end

    subgraph DATA["Camada de Memória & Persistência SQLite"]
        SQLITE[("SQLite Unificado (database.sqlite)")]
        WORKING_MEM[("Memória de Trabalho Cognitiva (Snapshot + Recência)")]
        VEC_RAG[("RAG Vetorial (sqlite-vec 3072 dims + Gemini)")]
        CONTEXT_DOCS[("Documentos Vivos por Contexto (context_documents)")]
        ENTITIES[("Grafo CRM & Entidades")]
        OPS_DATA[("Tabelas Operacionais (tasks, routines, followups, missions, trackers)")]
    end

    subgraph WORKERS["Serviços em Background & Workers"]
        FOLLOWUP_W["Follow-Up Worker (Cron 1h)"]
        EMAIL_W["Sentinela Gmail (Watcher)"]
        ROUTINE_W["Routine Manager (Cron)"]
        MAINT_W["Manutenção Diária (Cron 03:00)"]
        CONSOLIDATE_W["Consolidador Noturno (Cron 03:05)"]
    end

    WA_MAIN --> VOICE --> QUEUE
    WA_PERS --> QUEUE
    QUEUE --> CMD_ROUTER
    CMD_ROUTER -->|Comando Direto (/status, /novo)| WA_MAIN
    CMD_ROUTER -->|Mensagem Conversacional| LANGGRAPH

    LANGGRAPH <--> CHECKPOINT
    LANGGRAPH <--> DATA
    WORKERS <--> DATA
    WORKERS --> WA_MAIN

    SUMMARIZER --> SUPERVISOR
    SUPERVISOR --> SPECIALISTS
    SPECIALISTS --> SUPERVISOR
    SUPERVISOR --> EVALUATOR
    EVALUATOR -->|Reprovado| SUPERVISOR
    EVALUATOR -->|Aprovado| GATEWAY
    GATEWAY --> WA_MAIN
```

---

## 🤖 Matriz de Modelos e Provedores de IA

O ecossistema utiliza uma divisão estratégica de modelos para maximizar inteligência, precisão factual, respeito a esquemas JSON e custo-eficiência:

| Papel / Subsistema | Modelo / Provedor | Parâmetros & Configuração | Justificativa Arquitetural |
|---|---|---|---|
| **Supervisora Ativa** | `gpt-4o-mini` (OpenAI) | `temperature: 0.1` | Fluidez conversacional natural no WhatsApp, excelente seguimento de personas e respeito estrito a schemas JSON de roteamento. |
| **Auditor de Qualidade (Evaluator)** | `gpt-4o-mini` (OpenAI) | `temperature: 0.0` | Imparcialidade determinística, rigor factual (groundedness) e verificação estrita de ferramentas executadas vs alegações. |
| **Agentes Especialistas** | `deepseek-v4-flash` (DeepSeek) | `temperature: 0.3`, `thinking: disabled` | Execução rápida de chamadas de ferramentas, extração de dados brutos e baixo custo operacional. |
| **Decisões Estruturadas & Fallbacks** | `deepseek-v4-flash` (DeepSeek) | `temperature: 0.1`, baseURL beta | Resiliência via `invokeStructuredWithFallback` e compatibilidade Zod. |
| **Raciocínio Profundo (`reasoningAgent`)** | `deepseek-v4-flash` (DeepSeek) | `temperature: 0.2`, `thinking: enabled` (`8192` tokens) | Análise matemática, enigmas e planejamento de cenários estratégicos complexos com reflexão estendida. |
| **Embeddings Semânticos** | `gemini-embedding-001` (Google) | Vetores de 3072 dimensões float | RAG vetorial de alta dimensionalidade indexado nativamente pelo `sqlite-vec`. |
| **Transcrição de Voz** | `Whisper` (Groq Cloud) | Modelo `whisper-large-v3` via API Groq | Transcrição quase instantânea (<1.5s) de áudios e mensagens de voz recebidos no WhatsApp. |

---

## 🎯 Como Utilizar esta Documentação

1. **Para Entendimento Rápido:** Comece lendo [01-visao-geral-e-principios.md](01-visao-geral-e-principios.md), [02-fluxo-langgraph-e-estado.md](02-fluxo-langgraph-e-estado.md) e [03-supervisora-e-cenarios.md](03-supervisora-e-cenarios.md).
2. **Para Criar um Novo Especialista / Ferramenta:** Siga o passo a passo em [15-guia-de-evolucao-e-manutencao.md](15-guia-de-evolucao-e-manutencao.md) e consulte [04-skills-e-tools-registry.md](04-skills-e-tools-registry.md) e [05-agentes-especialistas.md](05-agentes-especialistas.md).
3. **Para Trabalhar com Memória e RAG:** Leia [06-sistema-de-memoria-e-rag.md](06-sistema-de-memoria-e-rag.md) e [07-crm-e-grafo-de-entidades.md](07-crm-e-grafo-de-entidades.md).
4. **Para Agentes de IA:** O arquivo [`AGENTS.md`](file:///Users/luiztordin/Code/biatordin/AGENTS.md) na raiz do projeto é a instrução mandatória do comportamento da IA; este diretório `docs/architecture/` é o detalhamento de referência técnica que **deve ser mantido atualizado a cada evolução**.
