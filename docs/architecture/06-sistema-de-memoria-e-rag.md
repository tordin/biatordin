# 06. Sistema de Memória Cognitiva, Working Memory & RAG

A arquitetura de memória da Bia combina **três paradigmas complementares e unificados 100% no SQLite**:
1. **Memória de Trabalho Cognitiva (Working Memory):** Ranqueada dinamicamente por uma **equação contínua de ativação** (Recência $\times$ Importância $\times$ Reforço), com injeção imediata de fatos recentes pós-snapshot e consolidada periodicamente via LLM.
2. **Memória Semântica de Longo Prazo (RAG Vetorial com Reconciliação):** `sqlite-vec` (3072 dimensões) + Embeddings do Gemini, com **Árbitro Semântico** na gravação para resolução de contradições e deduplicação inteligente.
3. **Memória Estruturada / Operacional:** Tabelas SQLite relacionais por domínio (`tasks`, `routines`, `topics`, `followups`, `missions`).

---

## 🏛️ Visão Geral das Camadas de Memória

```mermaid
flowchart TD
    subgraph INGESTION["1. Gravação com Reconciliação Semântica"]
        LLM["Supervisora / memoryAgent"] -->|Fato Sensível| VEC_PRE["Busca Vetorial Prévia (sqlite-vec, k=5, dist <= 0.35)"]
        VEC_PRE -->|Sem Candidatos| INSERT_FAST["INSERT Atômico (Zero Custo LLM)"]
        VEC_PRE -->|Candidatos Encontrados| ARBITER["Árbitro Semântico (semanticArbiter.ts)"]
        ARBITER -->|KEEP| INSERT_FAST
        ARBITER -->|UPDATE| UPD["UPDATE Texto/Importância"]
        ARBITER -->|DELETE| DEL["Expurgo Atômico (SQLite + vec_memories)"]
    end

    subgraph COGNITIVE["2. Motor Cognitivo & Tempo Real (workingMemory.ts)"]
        SQLITE[("long_term_memories + vec_memories")] --> CALC["Score: S = I^2 + (1 - I^2) * R(Δt) * F(n)"]
        CALC --> RT_CHECK["Verifica: updatedAt > snapshot.updated_at"]
        RT_CHECK -->|Pós-Snapshot (Qualquer Importância)| REALTIME["Injeta em 'Contexto & Fatos Recentes'"]
        RT_CHECK -->|Base Consolidada| SNAPSHOT[("working_memory_snapshot (SQLite)")]
        REALTIME & SNAPSHOT --> PROMPT["Contexto da Supervisora (Bia)"]
    end

    subgraph OFFLINE["3. Síntese Bidirecional & GC (memoryConsolidator.ts)"]
        SQLITE -->|Cron Diário 03:05| CONSOLIDATOR["LLM Consolidator (Flash + Zod)"]
        CONSOLIDATOR -->|1. Novo Markdown| SNAPSHOT
        CONSOLIDATOR -->|2. purgeIds (Contradições)| BATCH_DEL["Expurgo Físico no SQLite"]
        CONSOLIDATOR -->|3. demoteIds| BATCH_DEMOTE["Rebaixamento de Importância"]
        CONSOLIDATOR -->|4. GC Noturno| GC["Expurgo de Fatos Esquecidos (age > 90d, S < 0.05)"]
    end

    subgraph REINFORCEMENT["4. Reforço Sináptico (Hebbian Learning)"]
        RAG_RETRIEVE["Buscas RAG / Citações"] -.->|Hook Assíncrono| REINFORCE["reinforceMemory(ids)"]
        REINFORCE -.->|last_accessed_at = now, access_count++, +0.05 imp| SQLITE
    end
```

---

## 🧠 1. A Equação Contínua de Ativação Cognitiva

Cada fato armazenado em `long_term_memories` compete organicamente pelo espaço na memória de trabalho através da fórmula:

$$S(i, t) = I^2 + (1 - I^2) \cdot R(\Delta t) \cdot F(n)$$

* **Importância Intrínseca ($I \in [0.0, 1.0]$):**
  * Fatos vitais de perfil e família ($I = 1.0$) possuem score $1.000$ perenemente e **nunca saem** do topo da memória.
  * Fatos consolidados e preferências recebem $0.7 - 0.8$.
  * Detalhes pontuais e circunstanciais recebem $0.3 - 0.5$.
* **Curva Contínua de Recência ($R(\Delta t)$):**
  $$R(\Delta t) = \exp\left( -\left(\frac{\Delta t}{\tau}\right)^\gamma \right) \quad (\tau = 7\text{ dias}, \gamma = 0.8)$$
  * Fatos gravados hoje começam com $R \approx 1.0$ e decaem suavemente ao longo de dias e semanas.
* **Função de Reforço / Consolidação ($F(n)$):**
  $$F(n) = 0.6 + 0.4 \cdot \left( \frac{\ln(n + 1)}{\ln(10)} \right) \quad (n \ge 1)$$
  * Toda vez que um fato é citado, reconfirmado ou retornado em buscas RAG, ele ganha reforço (`access_count++`) e renova sua recência ($\Delta t = 0$).
* **Decay Duplo para Fatos de Sessão:** Fatos contextuais e de conversa (`category === 'conversa'` ou `contexto`) com importância $< 0.85$ recebem um decaimento acelerado (meia-vida de 4 horas), reduzindo a ativação rapidamente após o fim da sessão sem afetar os fatos perenes.

---

## ⚖️ 2. Reconciliação Semântica & Árbitro de Memória (`src/memory/semanticArbiter.ts`)

Para evitar inconsistências semânticas e contradições eternas no banco vetorial, a gravação de categorias sensíveis (`perfil`, `fato`, `preferencia`, `combinado`) utiliza `addVectorMemoryWithReconciliation`:

1. **Busca Local com Zero Custo LLM:** Gera o embedding do novo fato e executa uma busca vetorial nativa no `sqlite-vec` ($k=5$, $\text{distance} \le 0.35$). Se nenhum candidato similar for encontrado, a inserção é feita imediatamente.
2. **Mediação por LLM Flash Estruturado:** Se candidatos forem identificados, o `semanticArbiter` avalia a nova informação e classifica cada memória antiga:
   - `KEEP`: Se o fato antigo pertencer a outro sujeito (ex: "Manuela toca piano" vs "Luiz não toca piano") ou for complementar.
   - `UPDATE`: Se o fato antigo necessitar de refinamento de texto ou rebaixamento de importância.
   - `DELETE`: Se for uma contradição direta, anulação expressa ("não tenho pets", "não moro mais em Campinas") ou fato superado.
3. **Execução em Lote:** As deleções e atualizações são processadas de forma atômica no SQLite, sincronizando `long_term_memories` e a tabela virtual `vec_memories`.

---

## ⚡ 3. Injeção de Memória em Tempo Real (`src/memory/workingMemory.ts`)

A função `getWorkingMemoryContext` combina a estabilidade do snapshot consolidado com a reatividade imediata do chat, estruturada através de **slots dedicados** e **retrieval híbrido**:

- **Retrieval Híbrido com Reciprocal Rank Fusion (RRF):** Quando uma mensagem do usuário é processada, a busca mescla os últimos 300 fatos recentes/acessados (Canal A) com os top 50 fatos semânticos (Canal B - RAG). Os resultados são fundidos via RRF ($k=60$) e o score RRF é ponderado (50/50) com o score cognitivo contínuo, entregando altíssima precisão de contexto.
- **Sistema de Slots Reservados:** O orçamento de tokens da memória é dividido para evitar predação:
  - **Slot Core (30%):** Fatos de perfil e alta importância ($I \ge 0.85$). Piso garantido e imortal.
  - **Slot Sessão (25%):** Fatos recentes (últimas 4h) não-vitais, decaem rápido.
  - **Slot Relevância (45%):** Demais fatos ordenados por relevância híbrida/cognitiva.
- **Comparação de Timestamps & Reatividade:** Fatos registrados após a consolidação (`m.updatedAt > snapshotUpdatedAt`) ou pertencentes ao Slot Sessão são injetados diretamente no bloco `## 🔄 Contexto & Fatos Recentes`.
- **Deduplicação Inteligente:** Impede a repetição de fatos já consolidados textualmente no Markdown.

---

## 🌙 4. Consolidação de Sono Bidirecional & GC (`src/memory/memoryConsolidator.ts`)

Às **03:05 da manhã** (durante o repouso diário da assistente):
1. **Síntese Estruturada & Resiliência de Schema:** O consolidador analisa os top 180 fatos da base cognitiva e o snapshot anterior, gerando via Structured Output estrito:
   - `consolidatedMarkdown`: O documento estruturado, denso e limpo.
   - `purgeIds`: Lista de IDs que devem ser expurgados da base relacional e vetorial.
   - `demoteIds`: Lista de IDs cuja importância deve ser rebaixada (`id`, `newImportance`).
   - O schema Zod e o fallback em `src/utils/structuredOutput.ts` possuem recuperação determinística contra inconsistências de serialização JSON de objetos aninhados.
2. **Precedência de Declarações Negativas:** Correções explícitas forçam a remoção definitiva do fato incorreto tanto do Markdown compilado quanto da base SQLite.
3. **Garbage Collector Noturno (`runMemoryGarbageCollector`):** Remove itens com score cognitivo $S < 0.05$, criados há mais de 90 dias, sem acessos posteriores e com importância inicial $< 0.3$. Fatos de perfil vital ($I = 1.0$) são 100% imunes ao GC.

---

## 🔍 5. Memória Vetorial RAG (`src/memory/vectorMemory.ts`)

- **Mecanismo:** Extensão nativa `sqlite-vec` integrada ao SQLite.
- **Dimensões:** **3072 dimensões** geradas via [`src/memory/embeddings.ts`](../../src/memory/embeddings.ts) com modelo `gemini-embedding-001`.
- **Tabelas do Banco:**
  - `long_term_memories`: Guarda `id`, `content`, `category`, `chat_jid`, `importance`, `access_count`, `last_accessed_at`, `created_at`, `updated_at`, `metadata`.
  - `vec_memories`: Tabela virtual de vetores (`USING vec0(embedding float[3072])`).
  - `working_memory_snapshot`: Guarda o snapshot estruturado compilado e `updated_at`.

### Ferramentas do `memoryAgent`:
- `storeSemanticMemory(content, category, importance)`: Grava novo fato com auto-reconciliação semântica.
- `searchSemanticMemory(query, objective)`: Busca por similaridade de cosseno com disparo de reforço cognitivo automático.
- `searchEventSummary(keywords)`: Busca ampla por entidade com compilação de fatos e tarefas.
- `readMemory()`: Retorna a Memória de Trabalho Cognitiva atual compilada.
- `consolidateMemory()`: Força a consolidação bidirecional imediata sob demanda.
- `deleteSemanticMemory(memoryId, searchQuery)`: Remove fatos da base relacional e vetorial.
- `get_context_document(topicTitleOrId)`: Retorna o documento Markdown completo do tópico.
- `append_context_document(topicTitleOrId, text)`: Concatena anotações/histórico ao final do documento com compactação síncrona se exceder limite.
- `overwrite_context_document(topicTitleOrId, content)`: Sobrescreve o documento Markdown completo (para alteração estrutural de regras).
- `compact_context_document(topicTitleOrId)`: Força a compactação e arquivamento imediato do documento sob demanda.

---

## 🏷️ 6. Tópicos Conversacionais (`src/memory/topics.ts`)

- As conversas são associadas a tópicos com status `active` ou `archived`.
- O `topicCompiler.ts` compila as anotações e tarefas vinculadas ao tópico em discussão e as apresenta como contexto relevante para a Supervisora.
- O comando `/novo` ou `/reset` arquiva o tópico atual e inicia uma conversa limpa sem apagar memórias perenes.

---

## 📄 7. Documentos Vivos por Contexto (Scoped Living Documents)

O sistema de memória utiliza Documentos Vivos por Contexto (`context_documents` associados a `topicId`) para resolver limitações da busca vetorial em processos contínuos (como cardápios semanais, negociações ou manuais).

- **O Problema do RAG Aberto:** Recuperar fragmentos vetoriais falha quando a IA precisa de uma visão holística e contínua do estado atual e das regras em vigor.
- **Direct Fetch Determinístico (Zero-RAG Ingestion):** Quando uma missão, rotina agendada (Cron) ou o chat aciona um Tópico, o `topicCompiler.ts` puxa 100% do documento de contexto associado e injeta diretamente no System Prompt.
- **Compactação Semântica Síncrona:** O documento tem um orçamento estrito (ex: 6.000 caracteres). Se o limite for estourado após o salvamento, o `documentCompactor.ts` aciona a LLM síncronamente para:
  1. Preservar regras "sagradas" e permanentes sem alterá-las.
  2. Sumarizar e destilar os históricos diários.
  3. Extrair as anotações transitórias e enviá-las para o arquivamento seguro no RAG vetorial (`long_term_memories`).
- **Ferramentas (`memoryAgent`):** Oferecem à Bia a capacidade de fazer _append_ logando diários rápidos ou sobrescrever (_overwrite_) caso haja necessidade de edição estrutural de regras no meio do texto, sempre prezando a manutenção orgânica.

---

## 🔗 Documentos Relacionados
- 👉 [07. CRM Pessoal & Grafo de Entidades](07-crm-e-grafo-de-entidades.md)
- 👉 [13. Banco de Dados & Persistência](13-banco-de-dados-e-persistencia.md)
