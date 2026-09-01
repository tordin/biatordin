# 15. Guia de Evolução, Manutenção & Boas Práticas

Este documento serve como o **protocolo operacional obrigatório** para desenvolvedores e Agentes de IA que realizam manutenção, refatoração ou criação de novas funcionalidades no projeto **Bia**.

---

## 🚀 Passo a Passo: Como Criar um Novo Agente Especialista

Ao criar uma nova habilidade/especialista no sistema, você deve seguir **obrigatoriamente as 5 etapas a seguir**:

### Etapa 1: Registrar no Skills Registry (`src/skills/registry.ts`)
Cadastre a nova definição com `id`, `name`, `summary` (máximo 1 linha), `category`, `tools`, `detailedPrompt` e flags de permissão (`requiresTrusted` / `requiresCreator`).

### Etapa 2: Implementar o Agente em `src/agents/<novoAgente>.ts`
- Crie as tools usando a factory `tool(...)` do `@langchain/core/tools` com schemas Zod rigorosos.
- Utilize `createReactAgent` com `modelFlash` ou o modelo apropriado.
- Exporte a função nó empacotada no `safeAgentNode`:
  ```typescript
  export async function novoAgenteNode(state: typeof AgentState.State, config?: RunnableConfig) {
    return safeAgentNode("novoAgente", () => novoAgente, state, undefined, config);
  }
  ```

### Etapa 3: Adicionar a Rota na Supervisora (`src/agents/supervisor.ts`)
- Adicione o novo agente ao schema de roteamento da Supervisora (`nextAgent`).
- Se necessário, declare regras de acionamento nas instruções compartilhadas.

### Etapa 4: Conectar no Grafo LangGraph (`src/graph/workflow.ts`)
- Adicione o nó com `.addNode("novoAgente", novoAgenteNode)`.
- Adicione as arestas condicionais em `routeFromSupervisor` e `.addConditionalEdges("novoAgente", routeFromSpecialist, ...)`.

### Etapa 5: Criar Testes Unitários (`tests/agents/<novoAgente>.test.ts`)
- Escreva testes cobrindo os cenários de sucesso, falha e validação de schema.
- Execute `npm test` para garantir cobertura.

---

## 🛑 As 5 Regras de Ouro do Projeto

1. **NUNCA Inche o Prompt da Supervisora:** Nunca adicione descrições detalhadas de ferramentas dentro do prompt da Supervisora. O catálogo resumido deve vir exclusivamente de `getSkillCatalogSummary()`.
2. **NUNCA Salve Dados Operacionais no `bia_memory.md`:** Informações temporárias, tarefas, cotações e status devem residir no SQLite (`database.sqlite`), nunca no arquivo de perfil.
3. **Respeite a Precedência Estrita de Cenários:** Não permita que contas de terceiros acessem informações pessoais ou executem comandos de segurança.
4. **Mantenha os Tipos ESM Atualizados:** O projeto é ESM puro (`"type": "module"`). Todos os imports devem incluir a extensão `.js`.
5. **Schemas Zod Strict-Mode Compliant (OpenAI/DeepSeek):** Em TODOS os schemas usados com `withStructuredOutput` / `invokeStructuredWithFallback`:
   - ❌ **NUNCA** use `.optional()` isolado — gera campos fora do `required` do JSON Schema, rejeitado com HTTP 400.
   - ✅ Use `strictOptional(z.string())` de `src/utils/zodStrict.ts` para campos opcionais.
   - ✅ Use `.nullable().default(null)` diretamente (equivalente manual de `strictOptional`).
   - ✅ Use `strictArray(z.string())` ou `.default([])` em arrays que podem ser omitidos.
   - ✅ Para remapear chaves alternativas que o LLM pode gerar no fallback, use `fieldAliases` na chamada:
     ```typescript
     invokeStructuredWithFallback(model, schema, messages, {
       name: "MySchema",
       fieldAliases: { myField: ["alias1", "alias2"] }
     });
     ```
   - ✅ **NUNCA** adicione `if (options.name === "AlgumSchema")` em `structuredOutput.ts` — toda normalização específica deve ser declarada como `fieldAliases` no call site.
   - O motor de resiliência (`src/utils/structuredOutput.ts`) aplica automaticamente 4 camadas: invocação nativa → recuperação de erro → fallback com schema signature → normalizador semântico.
6. **Atualize a Documentação Arquitetural:** Toda vez que um módulo for alterado ou criado, atualize os documentos correspondentes em `docs/architecture/` e o [`AGENTS.md`](../../AGENTS.md).

---

## 🧪 Comandos Úteis de Desenvolvimento

```bash
# Executar em modo desenvolvimento (com WhatsApp ativo)
npm run dev

# Executar em modo desenvolvimento sem conectar o WhatsApp (ideal para testes locais)
npm run dev:no-wa

# Executar a suíte de testes automatizados (Jest ESM)
npm test

# Compilar o TypeScript (Strict Mode)
npm run build
```

---

## 🔗 Navegação da Documentação

- Voltar ao início da documentação:  
  👉 [README da Arquitetura](README.md)
