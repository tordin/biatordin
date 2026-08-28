# 09. Missões Autônomas com Terceiros

O sistema de **Missões Autônomas** permite que a Bia atue como negociadora e procuradora do Luiz, conversando diretamente com contatos de terceiros (prestadores de serviço, vendedores, fornecedores) pelo WhatsApp sem que o Luiz precise intervir a cada mensagem.

Os módulos responsáveis são [`src/memory/missions.ts`](../../src/memory/missions.ts) e [`src/agents/missionAgent.ts`](../../src/agents/missionAgent.ts).

---

## 🔄 Ciclo de Vida de uma Missão

```mermaid
sequenceDiagram
    autonumber
    actor Luiz as Luiz (Master)
    participant Sup as Supervisora (Bia)
    participant MA as missionAgent
    actor Alvo as Contato Terceiro (Target)
    participant DB as SQLite (missions)

    Luiz->>Sup: "Bia, fala com o pintor (1999999) e pede o orçamento do muro"
    Sup->>MA: Roteia com specialistTask e telefone
    MA->>DB: start_mission(masterJid, targetJid, objective, ttlHours: 72)
    MA->>Alvo: send_message_to_target("Olá, sou a Bia, assistente do Luiz...")
    MA-->>Sup: Missão iniciada
    Sup-->>Luiz: "Perfeito, já mandei mensagem para o pintor e te aviso assim que ele responder!"

    Note over Alvo,MA: Horas depois...
    Alvo->>Sup: "Boa tarde! O valor fica em R$ 850 com o material por conta dele."
    Sup->>MA: Reconhece Target ativo e roteia para missionAgent
    MA->>DB: update_mission_notes("Pintor cobrou R$ 850 com material do cliente")
    MA->>DB: complete_mission(id)
    MA->>Alvo: send_message_to_target("Obrigada pelo retorno! Vou repassar ao Luiz.")
    MA->>Luiz: notify_master("O pintor respondeu: orçamento ficou em R$ 850...")
```

---

## 🔒 Regras de Ouro e Isolamento Comunicacional

1. **A Supervisora NÃO Fala com o Alvo Diretamente:** Quando o chat atual pertence a um `Target` de missão ativa, a Supervisora **nunca** deve formular uma resposta direta no campo `response`. Toda comunicação é realizada exclusivamente pelo `missionAgent` via ferramentas (`send_message_to_target`, `notify_master`).
2. **Proibição de `intermediateMessage` no Chat do Alvo:** A Supervisora não emite mensagens de pensamento (ex: *"Consultando..."*) para não estragar a negociação com o terceiro.
3. **Notificação Estratégica ao Criador (`notify_master`):**
   - O `missionAgent` **não** incomoda o Luiz a cada mensagem do alvo.
   - Ele acumula dados nas anotações da missão (`update_mission_notes`) e notifica o criador **apenas quando:**
     - A) A missão for finalizada com sucesso.
     - B) O terceiro fizer uma pergunta crítica que só o Luiz sabe responder.
4. **Controle de Tempo de Vida (TTL):**
   - Tarefas urgentes (ex: *"pedir almoço agora"*): `ttlHours: 4`.
   - Negociações normais: `ttlHours: 72` (padrão) a `168` (7 dias).
   - O método `expireOldMissions()` cancela missões expiradas automaticamente em segundo plano.

---

## 🗄️ Esquema da Tabela `missions`

```sql
CREATE TABLE missions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  masterJid TEXT NOT NULL,          -- JID do criador (Luiz)
  targetJid TEXT NOT NULL,          -- JID do contato terceiro
  objective TEXT NOT NULL,          -- Objetivo da missão em linguagem natural
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'completed' | 'cancelled'
  notes TEXT,                       -- Histórico consolidado e anotações da negociação
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  expiresAt DATETIME,               -- Data/hora de expiração baseada no TTL
  ttlHours INTEGER
);

CREATE UNIQUE INDEX idx_unique_active_mission 
ON missions(masterJid, targetJid) WHERE status = 'active';
```

---

## 🔗 Próximos Passos & Documentos Relacionados

- Para entender o motor de cobranças e follow-ups integrado:  
  👉 [10. Follow-Up & Cobranças](10-follow-up-e-cobrancas.md)
- Para entender o transporte de mensagens:  
  👉 [08. Transporte WhatsApp & Mensageria](08-transporte-whatsapp-baileys.md)
