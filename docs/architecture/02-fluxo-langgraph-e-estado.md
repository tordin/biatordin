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

    COND_SUP -->|Delegar Especialista| SPECIALISTS["Especialistas (searchAgent, taskAgent, workspace, crm, etc.)"]
    COND_SUP -->|Modo Passivo / [SILENT] / Trivial| GATEWAY["outputGateway"]
    COND_SUP -->|Resposta Proposta com Execuções Prévias| EVALUATOR["evaluator"]

    SPECIALISTS --> COND_SPEC{"routeFromSpecialist"}
    COND_SPEC -->|Retornar Dados Coletados| SUPERVISOR
    COND_SPEC -->|Finalizar Direto| GATEWAY

    EVALUATOR --> COND_EVAL{"routeFromEvaluator"}
    COND_EVAL -->|Reprovado (Correção Necessária)| SUPERVISOR
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

### Principais Campos de `ContextData`:
- `chatJid` / `senderJid`: Identificadores WhatsApp do chat e do remetente da mensagem.
- `accountName`: Conta de origem (`'main'` para a conta oficial da Bia ou `'personal'` para a conta pessoal do Luiz).
- `isTrustedChat`: Booleano determinando se o chat possui permissão elevada.
- `isGroup`: Indica se a conversa ocorre em grupo (`@g.us`) ou privado (`@s.whatsapp.net`).
- `executionLog`: Lista ordenada de nomes de agentes executados durante o turno (ex: `['searchAgent', 'calendarAgent']`).
- `executedTools`: Lista de nomes de ferramentas executadas (ex: `['google_search', 'create_event']`).
- `specialistTask`: Instrução cirúrgica gerada pela Supervisora especificando o que o próximo especialista deve realizar.
- `activePlan`: Plano sequencial de múltiplos passos para execuções complexas.
- `proposedResponse`: Rascunho da resposta formulada pela Supervisora para avaliação do `evaluator`.
- `evaluationFeedback`: Motivo de reprovação e orientação corretiva enviada pelo `evaluator` à Supervisora.
- `outputMessages`: Fila de mensagens agendadas para envio out-of-band pelo `outputGateway`.

---

## 🔀 Regras de Roteamento

### 1. `routeFromSupervisor(state)`
Avalia a decisão da Supervisora e direciona:
- Se `nextAgent` for um especialista específico (ex: `taskAgent`, `gmailAgent`, `missionAgent`), roteia para o nó correspondente.
- Se for uma conta pessoal passiva (`accountName === 'personal'`), resposta silenciosa (`[SILENT]`) ou execução trivial sem ferramentas, **salta o avaliador** e vai direto ao `outputGateway`.
- Nos demais casos com ação executada, direciona para o `evaluator` para controle de qualidade.

### 2. `routeFromSpecialist(state)`
- Por padrão, retorna para o `supervisor` carregando os dados extraídos encapsulados na tag `<specialist_return>`.
- Caso o especialista sinalize `FINISH`, roteia diretamente para o `outputGateway`.

### 3. `routeFromEvaluator(state)`
- Se o veredito for `PASS`: direciona para `outputGateway`.
- Se o veredito for `NEEDS_CORRECTION`: devolve para a `supervisor` com feedback explícito no contexto (limitado a no máximo 2 ciclos de autocorreção).

---

## 💾 Persistência de Checkpoints (`SqliteSaver`)

Todas as threads de conversa são gravadas automaticamente no banco relacional `database.sqlite` através do `SqliteSaver` ([`src/memory/checkpointer.ts`](../../src/memory/checkpointer.ts)).

- **Chave da Thread:** O `thread_id` corresponde ao JID canônico do chat (ex: `5519997064504@s.whatsapp.net` ou `12036304@g.us`).
- **Recuperação:** Caso o processo seja reiniciado no meio de um atendimento, o LangGraph retoma a conversa a partir do último checkpoint com histórico íntegro.

---

## 🔗 Próximos Passos & Documentos Relacionados

- Para entender como a Supervisora decide o próximo nó e adapta suas respostas:  
  👉 [03. Supervisora & Precedência de Cenários](03-supervisora-e-cenarios.md)
- Para entender o funcionamento do nó auditor e do gateway de saída:  
  👉 [12. Avaliação de Qualidade & Segurança](12-avaliacao-qualidade-e-seguranca.md)
