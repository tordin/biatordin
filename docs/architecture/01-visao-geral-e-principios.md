# 01. Visão Geral do Sistema & Princípios Arquiteturais

A **Bia** é uma assistente virtual executiva e autônoma desenvolvida especificamente para operar no ecossistema do **WhatsApp** (via Baileys), atuando como o braço direito operacional e cognitivo do seu usuário criador (**Luiz**).

---

## 🎯 Propósito & Escopo do Sistema

Diferente de chatbots convencionais que apenas respondem perguntas baseadas em RAG simples, a Bia é um **sistema multiagentes orquestrado por grafo** com capacidade de:
1. **Raciocinar e planejar tarefas multi-etapas** em tempo real.
2. **Executar ações reais no mundo digital:** gerenciar Google Calendar, Gmail, Docs, Planilhas, Drive, gerir tarefas e lembretes, fazer buscas e cotações de preços.
3. **Agir de forma autônoma com terceiros (Missões):** conversar diretamente com prestadores de serviço, vendedores ou contatos via WhatsApp para agendar, negociar ou obter orçamentos, reportando ao criador somente os resultados consolidados.
4. **Atuar como Sentinela e Observadora Passiva:** monitorar conversas e e-mails recebidos, detectando pendências urgentes e cobrando prazos silenciosamente.

---

## 👤 Persona e Tom de Voz

- **Identidade:** Bia (flexão gramatical estritamente feminina).
- **Tom de Comunicação:** Natural, acolhedora, concisa, proativa e executiva. Adapta-se ao formato de mensagens do WhatsApp (evita blocos de texto pesados, cabeçalhos Markdown `#` excessivos ou listas excessivamente formais).
- **Relação com o Criador:** Trata o Luiz pelo nome ou de maneira natural e empática. **NUNCA** o chama de "Master", "Mestre" ou "Criador" nas mensagens finais.
- **Relação com Terceiros:** Cortês, prestativa, porém firme nos objetivos da missão encomendada pelo Luiz, com isolamento absoluto de dados sensíveis e privacidade.

---

## 🏛️ Pilares e Princípios de Design Arquitetural

### 1. Prevenção de Inchaço de Prompt (*Token Economy & Low Latency*)
- O System Prompt da Supervisora **nunca** carrega manuais longos de todas as ferramentas.
- Ela consome apenas o **Catálogo Resumido de Habilidades** via [`src/skills/registry.ts`](../../src/skills/registry.ts).
- Cada agente especialista consome seu próprio `detailedPrompt` e ferramentas atômicas **somente quando é invocado**.

### 2. Separação Estrita de Contextos e Camadas de Memória
- **Memória de Perfil (Core):** Fatos de vida perenes em Markdown ([`data/bia_memory.md`](../../data/bia_memory.md)). Nunca guarda tarefas efêmeras.
- **Armazenamento Operacional Dedicado (SQLite):** Tarefas, rotinas, follow-ups e histórico residem em tabelas estruturadas com esquemas rígidos.
- **Sandboxes Isolados por Chat:** Grupos ou conversas com terceiros nunca têm acesso à memória global do criador.

### 3. Autonomia com Groundedness e Guardrails
- Nenhuma resposta final pode afirmar ações que não foram registradas no log de ferramentas executadas (`executedTools` / `executionLog`).
- O nó **Evaluator (Auditor de Qualidade)** inspeciona as respostas da Supervisora antes do envio final, reprovando inconsistências ou alucinações.

### 4. Resiliência Operacional e Tolerância a Quedas
- O estado de cada chat é persistido via LangGraph Checkpointer (`SqliteSaver`).
- Quedas de processo não perdem mensagens: mensagens recebidas enquanto o sistema está ocupado ou reiniciando são mantidas em fila persistida (`pendingQueue.ts`).

---

## 🔗 Próximos Passos & Documentos Relacionados

- Para entender como o fluxo de execução é orquestrado entre a Supervisora e os Agentes, leia:  
  👉 [02. Fluxo LangGraph & Estado Compartilhado](02-fluxo-langgraph-e-estado.md)
- Para entender as regras de segurança e árvore de cenários de acesso:  
  👉 [03. Supervisora & Precedência de Cenários](03-supervisora-e-cenarios.md)
