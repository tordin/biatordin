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

## 🔁 Loop de Autocorreção & Circuit Breaker

- **`suggestedAction` (`ROUTE_TO_SPECIALIST`):** Quando o auditor identifica que faltou invocar um especialista, a Supervisora é terminantemente instruída a não encerrar com `FINISH` e sim direcionar `nextAgent` para o especialista com `specialistTask`.
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
