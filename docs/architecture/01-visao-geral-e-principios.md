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

### 2. Separação Estrita de Contextos e Persistência Unificada no SQLite
- **Memória de Trabalho Cognitiva (Working Memory & RAG em SQLite):** Persistida integralmente nas tabelas `long_term_memories`, `working_memory_snapshot` e `vec_memories` (3072 dimensões float via `sqlite-vec` + Gemini embeddings). Opera com score contínuo de ativação ($S = I^2 + (1 - I^2) \cdot R(\Delta t) \cdot F(n)$), retrieval híbrido (recência + semântica fundidos via RRF $k=60$) e sistema de slots orçamentários reservados (Core 30%, Sessão 25%, Relevância 45%).
- **Documentos Vivos por Contexto (Scoped Living Documents):** Documentos contínuos na tabela `context_documents` vinculados a tópicos (`topicId`). Fornecem injeção determinística (*Zero-RAG*) para processos contínuos (ex: cardápios, reformas, negociações), com compactação semântica síncrona que preserva regras invioláveis e arquiva excessos no RAG vetorial.
- **Espaços Operacionais Dedicados:** Afazeres (`tasks`), rotinas (`routines`), inventários JSON (`trackers`), cobranças (`followups`), missões (`missions`) e grafo de relacionamentos (`entities`) residem em tabelas SQLite com esquemas rígidos e integridade referencial.
- **Isolamento de Contexto & Sandboxes por Chat:** Grupos e terceiros interagem apenas com a memória restrita associada ao seu próprio JID ou tópico, com bloqueio absoluto de acesso à memória confidencial global do criador.

### 3. Autonomia com Groundedness e Guardrails
- Nenhuma resposta final pode afirmar ações que não foram registradas no log de ferramentas executadas (`executedTools` / `executionLog`).
- O nó **Evaluator (Auditor de Qualidade)** inspeciona as respostas da Supervisora antes do envio final, reprovando inconsistências ou alucinações.

### 4. Resiliência Operacional e Tolerância a Quedas
- O estado de cada chat é persistido via LangGraph Checkpointer (`SqliteSaver`).
- Quedas de processo não perdem mensagens: mensagens recebidas enquanto o sistema está ocupado ou reiniciando são mantidas em fila persistida (`pendingQueue.ts`).
- Conexão SQLite unificada e centralizada em [`src/memory/db.ts`](../../src/memory/db.ts) com modo WAL e isolamento estrito de testes (`database.test.sqlite`).

### 5. Matriz Estratégica Multi-Modelos
- O sistema não depende de um único LLM, mas aloca o modelo mais qualificado e eficiente para cada função:
  - **OpenAI `gpt-4o-mini`:** Supervisão conversacional ativa e auditoria de groundedness do Evaluator (temperaturas 0.1 e 0.0).
  - **DeepSeek `deepseek-v4-flash`:** Agentes especialistas atômicos e decisões estruturadas com alta velocidade e baixo custo.
  - **DeepSeek Pro Thinking (`budget_tokens: 8192`):** Raciocínio matemático e analítico complexo via `reasoningAgent`.
  - **Google `gemini-embedding-001`:** Embeddings semânticos vetoriais de 3072 dimensões float.
  - **Groq Whisper (`whisper-large-v3`):** Transcrição de voz quase em tempo real (<1.5s).

---

## 🔗 Próximos Passos & Documentos Relacionados

- Para entender como o fluxo de execução é orquestrado entre a Supervisora e os Agentes, leia:  
  👉 [02. Fluxo LangGraph & Estado Compartilhado](02-fluxo-langgraph-e-estado.md)
- Para entender as regras de segurança e árvore de cenários de acesso:  
  👉 [03. Supervisora & Precedência de Cenários](03-supervisora-e-cenarios.md)
- Para entender o sistema de memória e RAG em detalhes técnicos:  
  👉 [06. Sistema de Memória & RAG Híbrido](06-sistema-de-memoria-e-rag.md)
