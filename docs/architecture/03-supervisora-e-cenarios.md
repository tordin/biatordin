# 03. Supervisora & Precedência de Cenários

A **Supervisora** ([`src/agents/supervisor.ts`](../../src/agents/supervisor.ts)) é o cérebro central da arquitetura multiagentes da Bia. É o nó responsável por interpretar a intenção do usuário, planejar ações, delegar tarefas aos especialistas e consolidar a resposta final enviada ao WhatsApp.

---

## 🎯 Responsabilidades da Supervisora

1. **Classificação & Roteamento:** Seleciona o especialista mais adequado a partir do resumo do catálogo.
2. **Delegação Cirúrgica (`specialistTask`):** Em vez de repassar todo o histórico sem contexto, formula uma ordem direta e contextualizada para o especialista (ex: `"Buscar no Google o preço do iPhone 16 128GB na Amazon Brasil"`).
3. **Planejamento Sequencial (`plan`):** Decompõe objetivos multi-etapas em uma lista de passos e rastreia o progresso através de [`src/utils/planManager.ts`](../../src/utils/planManager.ts).
4. **Formulação da Resposta Final:** Sintetiza os dados retornados pelos especialistas em uma mensagem natural, acolhedora e formatada para o WhatsApp. Quando a solicitação ou rotina instruir silêncio sob determinada condição ou ausência de novidades, define deterministicamente `response = '[SILENT]'`.
5. **Mensagens Intermediárias (`intermediateMessage`):** Quando necessário, avisa proativamente o usuário antes de tarefas mais longas (ex: `"Consultando sua agenda..."`).

---

## 🛡️ Árvore de Precedência Estrita de Cenários

A Bia opera sob uma avaliação rígida e determinística de contexto executada na função `buildSupervisorPrompt(context)`:

```mermaid
flowchart TD
    EVAL{"Avaliação de Contexto"} --> C3{"accountName === 'personal'?"}
    C3 -->|Sim| SCENARIO_3["[Cenário 3] Conta Pessoal (Observadora Passiva)"]
    C3 -->|Não| C1A{"isMaster === true?"}
    
    C1A -->|Sim| SCENARIO_1A["[Cenário 1A] Interação Direta com o Criador (Acesso Total)"]
    C1A -->|Não| C_TRUST{"isTrustedChat === true?"}
    
    C_TRUST -->|Sim| C1_GROUP{"isGroup === true?"}
    C1_GROUP -->|Não (1-a-1)| SCENARIO_1B["[Cenário 1B] Contato Confiável 1-1"]
    C1_GROUP -->|Sim| SCENARIO_1C["[Cenário 1C] Grupo Confiável"]
    
    C_TRUST -->|Não| C2_GROUP{"isGroup === true?"}
    C2_GROUP -->|Sim| SCENARIO_2B["[Cenário 2B] Grupo Não-Confiável"]
    C2_GROUP -->|Não (1-a-1)| SCENARIO_2A["[Cenário 2A] 1-a-1 Não-Confiável (Terceiros / Missões)"]
```

### Detalhamento dos Níveis e Comportamentos:

| Cenário | Função de Prompt | Condição | Nível de Acesso | Comportamento Operacional |
|---|---|---|---|---|
| **[3] Conta Pessoal** | `buildScenario3_Prompt` | `accountName === 'personal'` | `passive` | **Silenciosa em 99% dos casos.** Analisa conversas do Luiz com terceiros sem falar diretamente com ninguém. Emite alertas privados diretamente ao Luiz caso identifique urgências graves. Forçado `nextAgent = FINISH` no código. |
| **[1A] Criador (Master)** | `buildScenario1A_Prompt` | `isMaster === true` | `creator` | **Acesso Irrestrito.** Controle total de segurança, acesso a toda a agenda, e-mails, permissões, missões, sentinela e gerenciamento de grupos. |
| **[1B] Contato Confiável 1-1** | `buildScenario1B_Prompt` | `isTrustedChat && !isGroup` | `trusted` | **Acesso Elevado Colaborativo.** Pode acessar calendários e informações autorizadas, mas ferramentas críticas de segurança e sentinela são bloqueadas (`requiresCreator: true`). |
| **[1C] Grupo Confiável** | `buildScenario1C_Prompt` | `isTrustedChat && isGroup` | `trusted` | **Participação Ativa no Grupo.** Responde quando solicitada pelo nome ("Bia"), em resposta direta ou para colaborar com o objetivo do grupo. |
| **[2B] Grupo Não-Confiável** | `buildScenario2B_Prompt` | `!isTrustedChat && isGroup` | `restricted` | **Modo Silencioso por Padrão.** Só responde se for chamada explicitamente pelo nome ("Bia") ou se for resposta direta a uma mensagem dela. Foco no sandbox local. |
| **[2A] 1-a-1 Não-Confiável** | `buildScenario2A_Prompt` | Fallback (`!isTrustedChat && !isGroup`) | `restricted` | **Modo Missão / Proteção.** Nunca oferece serviços pessoais a terceiros. Atua estritamente para cumprir tarefas determinadas pelo criador (ex: negociações). |

---

## 🧩 Injeção Dinâmica de Prompts & Prevenção de Bloat

Para garantir latência ultrabaixa e respostas precisas, o System Prompt da Supervisora é composto dinamicamente a cada turno:

1. **Regras Compartilhadas (`SHARED_RULES`):** Persona Bia, formatação WhatsApp, regras de auditoria e segurança.
2. **Catálogo Resumido:** Gerado por `getSkillCatalogSummary(accessLevel)`, listando apenas as habilidades permitidas para o nível atual do chat.
3. **Memória de Perfil & Retrieval Híbrido (`<user_profile_data>` ou `<local_chat_memory>`):** A Supervisora invoca `getWorkingMemoryContext(chatJid, isTrustedChat, undefined, undefined, lastUserMessage)`. O motor executa busca híbrida (Canal A recência + Canal B busca vetorial RAG da mensagem do usuário) fundida por RRF, preenchendo os slots Core (perenes), Sessão (últimas 4h) e Relevância (semântica).
4. **Contexto de Missões Ativas:** Injeta detalhes se o chat atual for alvo (`Target`) de uma missão em andamento ou se o criador estiver gerenciando missões.
5. **Contexto de Tópico / Assunto:** Injeta dados compilados do tópico temático ativo ([`src/memory/topicCompiler.ts`](../../src/memory/topicCompiler.ts)).
6. **Auditoria de Auto-Explicação:** Se o usuário perguntar *"como você fez isso?"*, dados de auditoria do turno anterior são disponibilizados para explicação transparente.

---

## 📱 Formatador para Estilo WhatsApp

A função `reformatToWhatsAppStyle(text)` sanitiza a resposta final antes do envio:
- Remove headers markdown (`#`, `##`, `###`).
- Converte `**texto**` (Markdown bold) para `*texto*` (WhatsApp bold).
- Converte listas com `- item` para bullets visuais `• item`.
- Converte links markdown `[Texto](url)` para `Texto (url)`.
- Elimina tags internas residuais de raciocínio ou DSML (`<invoke>`, `<tool_calls>`).

---

## ⚙️ Engine de Saída Estruturada & Resiliência a Schemas

A Supervisora e os módulos de decisão estruturada utilizam a função `invokeStructuredWithFallback` ([`src/utils/structuredOutput.ts`](../../src/utils/structuredOutput.ts)):

1. **Compatibilidade DeepSeek (HTTP 400 Prevention):** O modelo DeepSeek exige que todas as propriedades do schema constem no array `required` do JSON Schema. Para isso, os campos opcionais são modelados com `.nullable().default(null)`.
2. **Resiliência a `undefined` (Zod Tolerance):** Quando o modelo gera JSONs enxutos omitindo propriedades nulas (ex: `{ "nextAgent": "FINISH", "response": "[SILENT]" }`), o Zod aplica automaticamente o valor default `null` sem disparar erros de tipo `expected string, received undefined`.
3. **Recuperação Direta e Fallback Regex:** Caso o parser nativo do LangChain falhe por invólucros markdown ou erros de sintaxe (`: ,`), a engine intercepta os argumentos brutos, sanitiza via `extractAndParseJson` e valida com `schema.parse(parsed)`.

---

## 🔗 Próximos Passos & Documentos Relacionados

- Para entender como as Skills e Ferramentas são catalogadas:  
  👉 [04. Skills & Tools Registry](04-skills-e-tools-registry.md)
- Para entender o funcionamento dos agentes especialistas:  
  👉 [05. Agentes Especialistas](05-agentes-especialistas.md)
- Para entender as missões autônomas com contatos de terceiros:  
  👉 [09. Missões Autônomas com Terceiros](09-missoes-autonomas.md)
