# 02. Fluxo LangGraph & Estado Compartilhado

A orquestração do ciclo de vida das mensagens e decisões da **Bia** é implementada sobre o **LangGraph** (`@langchain/langgraph`), permitindo um grafo direcionado cíclico com persistência de estado e tolerância a falhas.

O arquivo principal da definição do grafo é [`src/graph/workflow.ts`](../../src/graph/workflow.ts).

---

## 🔄 Topologia do Grafo

```mermaid
flowchart TD
    START(["__start__"]) --> COND_START{"shouldSummarize?"}
    COND_START -->|Histórico Longo| SUMMARIZER["summarizer"]
    COND_START -->|Histórico Normal| SUPERVISOR["supervisor"]
    SUMMARIZER --> SUPERVISOR

    SUPERVISOR --> COND_SUP{"routeFromSupervisor"}

    COND_SUP -->|Delegar Especialista (1 de 19)| SPECIALISTS["Agentes Especialistas<br/>(search, calendar, gmail, sentinel, sheets, docs, drive,<br/>routine, memory, task, tracker, security, shopping,<br/>whatsapp, reasoning, weather, mission, followUp, crm)"]
    COND_SUP -->|Modo Passivo / [SILENT] / Trivial| GATEWAY["outputGateway"]
    COND_SUP -->|Resposta Proposta com Ações Prévias| EVALUATOR["evaluator"]

    SPECIALISTS --> COND_SPEC{"routeFromSpecialist"}
    COND_SPEC -->|Retornar Dados (<specialist_return>)| SUPERVISOR
    COND_SPEC -->|Finalizar Direto (FINISH)| GATEWAY

    EVALUATOR --> COND_EVAL{"routeFromEvaluator"}
    COND_EVAL -->|Reprovado (NEEDS_CORRECTION)| SUPERVISOR
    COND_EVAL -->|Aprovado (PASS)| GATEWAY

    GATEWAY --> END_NODE(["__end__"])
```

---

## 📦 Estrutura do Estado Compartilhado (`AgentState`)

Definido em [`src/agents/state.ts`](../../src/agents/state.ts), o estado do grafo é gerenciado pela estrutura `AgentState`:

```typescript
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  nextAgent: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "supervisor",
  }),
  contextData: Annotation<ContextData>({
    reducer: (x, y) => { /* Mescla contextData, appends de logs e outputMessages */ },
    default: () => ({ executionLog: [], outputMessages: [] }),
  }),
});
```

### Especificação dos Campos de `ContextData`:

| Campo | Tipo | Finalidade Técnica |
|---|---|---|
| `chatJid` / `senderJid` | `string` | JIDs do chat e do remetente no WhatsApp (número canônico ou `@lid`). |
| `chatName` / `senderName` | `string` | Nomes amigáveis e pushNames normalizados. |
| `accountName` | `'main' \| 'personal'` | Conta de origem da interação (`main` para bot oficial, `personal` para conta passiva do Luiz). |
| `isMaster` | `boolean` | `true` se o remetente for o Luiz (Master/Criador), conferindo privilégio total. |
| `isTrustedChat` | `boolean` | `true` se o chat foi autorizado na tabela `trusted_chats`. |
| `isGroup` | `boolean` | `true` para grupos WhatsApp (`@g.us`). |
| `topicId` | `string` | Tópico conversacional ativo associado à conversa ou missão. |
| `executionLog` | `string[]` | Histórico sequencial de agentes acionados neste turno (ex: `['searchAgent', 'calendarAgent']`). |
| `executedTools` | `string[]` | Lista exata de nomes de ferramentas invocadas pelos especialistas durante o turno. |
| `specialistTask` | `string` | Ordem cirúrgica formulada pela Supervisora para o especialista a seguir. |
| `activePlan` | `PlanStep[]` | Plano multi-passos rastreado via [`src/utils/planManager.ts`](../../src/utils/planManager.ts). |
| `proposedResponse` | `string` | Rascunho da resposta redigida pela Supervisora para submissão ao `evaluator`. |
| `evaluationAttempts` | `number` | Contador de ciclos de correção (máximo de 2 tentativas antes do circuit breaker). |
| `evaluationFeedback` | `string` | Orientação corretiva gerada pelo `evaluator` em caso de reprovação. |
| `evaluationSuggestedAction` | `ROUTE_TO_SPECIALIST \| FIX_RESPONSE_TEXT \| PASS` | Ação prescrita pelo auditor para guiar a Supervisora. |
| `outputMessages` | `Array<{targetJid, message, accountName}>` | Fila de disparos out-of-band consumida pelo `outputGateway`. |
| `triggerType` | `string` | Origem do gatilho (`'user_message'`, `'cron_routine'`, `'system_inject'`). |
| `isScheduledRoutine` | `boolean` | `true` se a execução partiu do agendador automático de rotinas. |
| `silenceReason` | `string` | Justificativa estruturada quando a resposta determinística for `[SILENT]`. |

---

## 🔀 Regras de Roteamento Detalhadas

### 1. `routeFromSupervisor(state)`
Avalia a decisão da Supervisora e direciona:
- **Especialistas (19 opções):** Se `nextAgent` corresponder a qualquer um dos especialistas cadastrados (`searchAgent`, `calendarAgent`, `gmailAgent`, `emailSentinelAgent`, `sheetsAgent`, `docsAgent`, `driveAgent`, `routineAgent`, `memoryAgent`, `taskAgent`, `trackerAgent`, `securityAgent`, `shoppingAgent`, `whatsappAgent`, `reasoningAgent`, `weatherAgent`, `missionAgent`, `followUpAgent`, `crmAgent`), a execução transita imediatamente para o nó especialista.
- **Fast Bypass para `outputGateway`:** Salta o avaliador e envia diretamente se:
  - For a conta pessoal passiva (`accountName === 'personal'`).
  - A resposta for intencionalmente silenciosa (`proposedResponse === '[SILENT]'`).
  - Nenhuma ferramenta ou agente foi executado (resposta puramente conversacional/trivial).
- **Controle de Qualidade (`evaluator`):** Em todos os demais casos em que houve ferramentas ou agentes executados, direciona para o `evaluator`.

### 2. `routeFromSpecialist(state)`
- **Padrão:** Retorna para a `supervisor` carregando os dados extraídos encapsulados na tag `<specialist_return>`.
- **Encerramento Imediato:** Se o especialista sinalizar `nextAgent = 'FINISH'`, direciona direto para o `outputGateway`.

### 3. `routeFromEvaluator(state)` & Command API
- **Aprovado (`PASS`):** Direciona para `outputGateway`.
- **Subversão Direta via Command API (`ROUTE_TO_SPECIALIST`):** Se reprovado por omissão de especialista operacional, o `evaluatorNode` retorna um `Command({ goto: requiredCorrectionAgent, update: { specialistTask, ... } })`, subvertendo a aresta condicional e pulando diretamente para o especialista sem retornar para a Supervisora.
- **Reprovado Textual (`FIX_RESPONSE_TEXT`):** Devolve para a `supervisor` acompanhado de `evaluationFeedback` e `evaluationSuggestedAction`.
  - **Bypass do Repetition Guard:** Se `evaluationSuggestedAction === 'ROUTE_TO_SPECIALIST'`, a trava de re-chamada de agentes idênticos na Supervisora é temporariamente desabilitada para permitir que o especialista correto seja invocado.
  - **Orçamento Dinâmico:** O limite de chamadas da Supervisora expande dinamicamente para `5 + evaluationAttempts` (máximo de 7 chamadas).
  - **Circuit Breaker:** Se atingir 2 reprovações, o validador sanitiza deterministicamente as afirmações não executadas e encerra o pipeline via `outputGateway`.

---

## 💾 Persistência de Checkpoints (`SqliteSaver`)

Todas as threads de conversa são gravadas automaticamente no banco relacional `database.sqlite` através do `SqliteSaver` ([`src/memory/checkpointer.ts`](../../src/memory/checkpointer.ts)).

- **Chave da Thread:** O `thread_id` corresponde ao JID canônico do chat (ex: `5519997064504@s.whatsapp.net` ou `12036304@g.us`).
- **Recuperação Transacional:** Caso o processo seja reiniciado no meio de um atendimento ou durante o processamento de uma mensagem, o LangGraph retoma a conversa a partir do último checkpoint com histórico íntegro.

---

## 🔗 Próximos Passos & Documentos Relacionados

- Para entender como a Supervisora decide o próximo nó e adapta suas respostas:  
  👉 [03. Supervisora & Precedência de Cenários](03-supervisora-e-cenarios.md)
- Para entender o catálogo de ferramentas e permissões:  
  👉 [04. Skills & Tools Registry](04-skills-e-tools-registry.md)
- Para entender a especificação detalhada de todos os 19 especialistas:  
  👉 [05. Agentes Especialistas](05-agentes-especialistas.md)
- Para entender o funcionamento do nó auditor e do gateway de saída:  
  👉 [12. Avaliação de Qualidade & Segurança](12-avaliacao-qualidade-e-seguranca.md)
