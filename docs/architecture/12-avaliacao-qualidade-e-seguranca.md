# 12. Avaliação de Qualidade, Guardrails & Segurança

Para garantir que a Bia seja confiável, factual e protegida contra engenharia social e alucinações, o sistema conta com uma camada de **auditoria e controle de qualidade pós-execução**.

Os módulos centrais são [`src/agents/evaluator.ts`](../../src/agents/evaluator.ts), [`src/agents/outputGateway.ts`](../../src/agents/outputGateway.ts), [`src/utils/toolSeals.ts`](../../src/utils/toolSeals.ts), [`src/utils/responseValidator.ts`](../../src/utils/responseValidator.ts) e [`src/utils/executionAudit.ts`](../../src/utils/executionAudit.ts).

---

## 🧐 O Nó `evaluator` (Auditor de Qualidade)

Antes de uma mensagem final ser enviada ao usuário, o nó `evaluator` realiza uma checagem rigorosa com modelo LLM determinístico (`temperature: 0.0`):

```mermaid
flowchart TD
    SUP_RESP["Supervisora formula proposedResponse"] --> EVAL["evaluator (Auditor Imparcial)"]
    
    EVAL --> FAST_BYPASS{"Fast Bypass?<br/>(Modo passivo / [SILENT] / Trivial)"}
    FAST_BYPASS -->|Sim| GATEWAY["outputGateway (Entrega Imediata)"]
    
    FAST_BYPASS -->|Não| AUDIT["Auditoria LLM com EvaluationSchema"]
    AUDIT --> VERDICT{"Veredito"}
    
    VERDICT -->|PASS| GATEWAY
    VERDICT -->|NEEDS_CORRECTION| ATTEMPTS{"Tentativas >= 2?"}
    
    ATTEMPTS -->|Sim (Circuit Breaker)| SANITIZE["Sanitização Determinística Forçada"] --> GATEWAY
    ATTEMPTS -->|Não| LOOP_BACK["Devolve para Supervisora com feedback"] --> SUP_RESP
```

---

## 🎯 Critérios de Auditoria do Evaluator

1. **Groundedness (Fundamentação Factual & Execução Real):** A resposta alega ter feito algo (ex: *"agendei na sua agenda"*, *"enviei o e-mail"*, *"modifiquei a rotina"*) sem que a respectiva ferramenta conste em `executedTools`?
   - Se houver falsa afirmação de ação → **Reprova (`NEEDS_CORRECTION`)** e define `suggestedAction = 'ROUTE_TO_SPECIALIST'`.
2. **Ordens de Ação vs. Consulta Passiva:** O usuário solicitou explicitamente a alteração/criação/exclusão de um registro (rotina, tarefa, evento, email) e a IA respondeu apenas textualmente sem acionar a ferramenta correspondente?
   - O Evaluator **reprova obrigatoriamente**, emitindo feedback para a Supervisora executar o especialista de ação (`routineAgent`, `taskAgent`, etc.), bloqueando o encerramento do turno com `FINISH`.
3. **Resultados Negativos & Registros Inexistentes:** Se o especialista foi executado e constatou que o registro não existe (ex: rotina não encontrada, tarefa inexistente, sem e-mails), a resposta informando claramente a não localização é 100% CORRETA e DEVE receber `verdict = 'PASS'`. O Evaluator é proibido de forçar `ROUTE_TO_SPECIALIST` para tentar deletar ou modificar itens inexistentes.
4. **Completude:** Todas as perguntas ou etapas solicitadas pelo usuário foram respondidas?
5. **Persona & Segurança:** Respeita o tom amigável e feminino? Não chamou o usuário de "Master"? Não vazou dados confidenciais para terceiros?
6. **Silêncio Intencional / Condicional:** Quando o usuário ou rotina pedir explicitamente para não enviar mensagem / ficar em silêncio se uma condição for atendida, e os dados coletados confirmarem que a condição foi satisfeita, a resposta `[SILENT]` é 100% CORRETA e deve receber `verdict = 'PASS'`. O Avaliador é terminantemente proibido de exigir que a assistente envie mensagens apenas para "avisar que decidiu ficar em silêncio".
7. **Flexibilidade Estilística no WhatsApp:** Variações normais de formato ou a ausência de jargões técnicos internos (ex: "busquei na minha memória" ou "encontrei na conta personal") NÃO constituem falhas e devem ser aprovadas com `verdict = 'PASS'`.

---

## 🔁 Loop de Autocorreção, Command API (LLM-Modulo) & Circuit Breaker

- **Subversão de Controle via Command API (`ROUTE_TO_SPECIALIST`):** Quando o auditor identifica que uma ação exigida pelo usuário não foi executada (ex: faltou acionar ferramenta operacional), o Evaluator infere `requiredCorrectionAgent` e `inferredSpecialistTask`. Em vez de devolver texto para a Supervisora (evitando deadlock cognitivo), o `evaluatorNode` utiliza a **Command API** do LangGraph (`new Command({ goto: requiredCorrectionAgent, update: { specialistTask, ... } })`) para rotear deterministicamente direto para o especialista. Após a execução do especialista, o fluxo retorna naturalmente para a Supervisora compor a resposta com os dados consolidados.
- **Marcadores Epistêmicos & Bypass de Leitura Passiva (`passiveReferencesUsed`):** Fatos injetados da memória de trabalho recebem carimbos `[MemID: ...]`. Ao responder com base no RAG/SQLite sem acionar ferramentas operacionais, a Supervisora preenche `passiveReferencesUsed` no schema estruturado. O Evaluator valida esses marcadores e aprova com `verdict = 'PASS'`, eliminando falsos positivos de groundedness.
- **Isenção do Repetition Guard:** O guard de repetição de agentes da Supervisora (`isRepeatingAgent`) **não dispara** quando o Evaluator emitiu `ROUTE_TO_SPECIALIST`. Isso permite que o mesmo agente seja re-chamado com uma `specialistTask` diferente (ex: `routineAgent` para listar e depois para deletar). O log `[EVALUATOR_RETRY]` sinaliza que a repetição foi autorizada pelo auditório. Sem esta isenção, o guard bloquearia a correção antes que ela pudesse acontecer.
- **Budget Dinâmico de Execuções:** O limite `maxAgentCalls` da Supervisora é **`5 + evaluationAttempts`** — ou seja, cada ciclo de avaliação reprovado ganha +1 chamada extra de agente. Com `MAX_EVALUATION_CYCLES = 2`, o máximo possível é 7 chamadas de agentes por turno, garantindo orçamento para as correções sem criar risco de loop infinito.
- **Limpeza de Feedback Após Consumo:** Quando a Supervisora roteia com sucesso para um especialista após receber feedback do Evaluator (`nextAgent !== "FINISH"`), `evaluationFeedback` e `evaluationSuggestedAction` são limpos do `contextData`. Isso garante que o bypass do repetition guard esteja ativo **apenas** durante o ciclo de correção correto, e não em execuções posteriores.
- **Circuit Breaker:** Se após `MAX_EVALUATION_CYCLES` (2 tentativas) a resposta ainda apresentar inconsistências, o `validateResponseConsistency` substitui deterministicamente alegações não executadas por declarações honestas de impossibilidade técnica antes do envio, impedindo que falsas confirmações cheguem ao usuário.

---

## 🛡️ Selos de Ferramentas & Validação Determinística

- **`toolSeals.ts`:** Assina a resposta com metadados determinísticos comprovando quais ferramentas respaldaram aquela informação.
- **`responseValidator.ts`:** Validador regex de última linha que reescreve automaticamente trechos onde o modelo afirma ter agendado ou enviado mensagens se o log de execução estiver vazio.

---

## 🚪 O Nó `outputGateway`

O `outputGateway` é o ponto final do grafo LangGraph antes de `__end__`. Ele:
1. Processa a fila `outputMessages` para envios out-of-band (ex: quando um especialista precisa mandar uma mensagem para o Target e outra para o Master).
2. Sincroniza o histórico de chat de terceiros.
3. Limpa estados voláteis da memória do grafo.

---

## 🔗 Próximos Passos & Documentos Relacionados

- Para entender o banco de dados onde tudo é persistido:  
  👉 [13. Banco de Dados & Persistência](13-banco-de-dados-e-persistencia.md)
- Para entender a observabilidade e dashboard de auditoria:  
  👉 [14. Observabilidade, API & Debugger](14-observabilidade-api-e-debugger.md)
