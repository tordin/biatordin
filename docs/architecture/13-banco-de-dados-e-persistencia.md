# 13. Banco de Dados & Persistência

A persistência do ecossistema da Bia é centralizada no arquivo relacional **`database.sqlite`** na raiz do projeto (gerenciado pelo módulo central [`src/memory/db.ts`](../../src/memory/db.ts)), operando com modo WAL (*Write-Ahead Logging*) para suporte a concorrência entre o motor de IA, workers em background e a API de observabilidade.


---

## 🛡️ Gerenciador Central de Conexão & Isolamento de Testes (`src/memory/db.ts`)

Todas as conexões com o SQLite são obtidas exclusivamente através de [`src/memory/db.ts`](../../src/memory/db.ts):
- **`getDbPath()`**: Resolve o caminho do banco ativo. Prioriza a variável `process.env.SQLITE_DB_PATH` (se definida) e faz fallback para `database.sqlite`.
- **`getDb()`**: Singleton da conexão SQLite com ativação automática de `PRAGMA journal_mode = WAL;` e `PRAGMA busy_timeout = 5000;`.
- **`closeDb()`**: Encerramento seguro da conexão.

### 🧪 Isolamento em Testes Automatizados (Jest)
- Durante a execução de testes (`npm test`), o arquivo `tests/setupEnv.js` define `process.env.SQLITE_DB_PATH = 'database.test.sqlite'`.
- Todos os testes unitários e de integração operam em um banco de teste temporário (`database.test.sqlite`), **garantindo isolamento total e zero poluição na base de produção (`database.sqlite`)**.
- No encerramento da suíte (`tests/globalTeardown.js`), os arquivos `database.test.sqlite*` são fisicamente removidos do disco.


---

## 🗄️ Catálogo de Tabelas do Sistema

| Tabela | Módulo Responsável | Finalidade |
|---|---|---|
| `checkpoints` / `checkpoint_blobs` / `checkpoint_writes` | `src/memory/checkpointer.ts` | Estado e histórico das threads do LangGraph gerenciadas pelo `SqliteSaver`. |
| `trusted_chats` | `src/memory/security.ts` | JIDs com permissão elevada e autorização de acesso ao perfil e workspace. |
| `topics` | `src/memory/topics.ts` | Tópicos conversacionais ativos e arquivados por chat. |
| `tasks` | `src/memory/tasks.ts` | Tarefas e afazeres pendentes/concluídos com prazos e categorias. |
| `routines` | `src/memory/routines.ts` | Rotinas e lembretes agendados com expressões Cron. |
| `missions` | `src/memory/missions.ts` | Missões ativas com terceiros, anotações de negociação e expiração por TTL. |
| `followups` | `src/memory/followUps.ts` | Cobranças de terceiros (`waiting_for_them`) e promessas assumidas (`promised_by_me`). |
| `entities` | `src/memory/entities.ts` | Grafo de pessoas, empresas, projetos, apelidos e preferências declaradas. |
| `entity_relationships` | `src/memory/entities.ts` | Vínculos relacionais direcionados entre entidades do grafo. |
| `contacts` | `src/memory/contacts.ts` | Catálogo legado de contatos, nomes e pushNames sincronizados do WhatsApp. |
| `long_term_memories` | `src/memory/vectorMemory.ts` | Metadados e pontuações cognitivas (`importance`, `access_count`, `last_accessed_at`) das memórias RAG. |
| `vec_memories` | `src/memory/vectorMemory.ts` | Tabela virtual `sqlite-vec` (vetores de 3072 dimensões com Gemini embeddings). |
| `working_memory_snapshot` | `src/memory/workingMemory.ts` | Snapshot sintetizado e cacheado da Memória de Trabalho consolidada. |
| `email_sentinel_rules` | `src/memory/emailSentinel.ts` | Regras de descarte (`ignore`) e prioridade (`priority`) do Inbox Watcher. |
| `email_sentinel_logs` | `src/memory/emailSentinel.ts` | Histórico de e-mails processados e classificados pelo sentinela. |
| `daily_summary_groups` | `src/memory/dailySummary.ts` | JIDs dos grupos selecionados para gerar o resumo diário automatizado. |
| `pending_messages` | `src/memory/pendingQueue.ts` | Fila persistida de mensagens em trânsito para recuperação em caso de restart. |

---

## 🔍 Monitoramento de Integridade (`dbMonitor.ts`)

O módulo [`src/utils/dbMonitor.ts`](../../src/utils/dbMonitor.ts) executa na inicialização e monitora a integridade estrutural do banco de dados:
- Executa periodicamente `PRAGMA integrity_check`.
- Monitora tempo de locks de escrita para evitar bloqueios de banco (`SQLITE_BUSY`).
- Registra alertas no logger caso haja anomalias estruturais.

---

## 🧹 Higienização & Manutenção Automática (`src/utils/maintenance.ts`)

Para evitar inchaço do SQLite por acúmulo descontrolado de checkpoints intermediários do LangGraph:
- **Janela de Retenção (14 dias):** Checkpoints com mais de 14 dias são removidos, preservando estritamente o checkpoint mais recente de cada thread ativa.
- **Limpeza de Writes Órfãos:** Registros de canais intermediários sem checkpoint associado são eliminados.
- **Compactação com `VACUUM` & `PRAGMA wal_checkpoint(TRUNCATE)`:** Executada automaticamente para recuperar espaço em disco e manter o banco compacto (~15-50 MB).
- **Execução Agendada:** Inicializada no bootstrap (`src/index.ts`) para rodar diariamente às 03:00 via cron, com comando manual via `npm run clean:logs`.

---

## 🔗 Próximos Passos & Documentos Relacionados

- Para entender o sistema de logging e API de observabilidade:  
  👉 [14. Observabilidade, API & Debugger](14-observabilidade-api-e-debugger.md)
- Para o guia prático de manutenção e novos recursos:  
  👉 [15. Guia de Evolução & Manutenção](15-guia-de-evolucao-e-manutencao.md)
