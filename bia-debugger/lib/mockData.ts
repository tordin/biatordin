export type Chat = {
  id: string
  name: string
  lastMessage: string
  time: string
  unread: number
  avatar: string
}

export const mockChats: Chat[] = [
  { id: '1', name: 'Luiz Tordin (Master)', lastMessage: 'Bia, você pode checar se a matrícula da Cecília no Imaculada tá confirmada?', time: '10:42', unread: 0, avatar: 'L' },
  { id: '2', name: 'Luciana Tordin', lastMessage: 'Bia: Mandei mensagem pro Luiz sobre os docinhos da festa da Cecília.', time: '09:15', unread: 1, avatar: 'Lu' },
  { id: '3', name: 'Missão OLX: Pneu Michelin', lastMessage: 'Vendedor: Faço por R$ 350 o par se retirar hoje.', time: '08:30', unread: 0, avatar: 'M' },
  { id: '4', name: 'Grupo Família Tordin', lastMessage: 'Bia: [Lembrete] Aula de piano da Manuela às 14h.', time: 'Ontem', unread: 0, avatar: 'F' },
]

export type Message = {
  id: string
  chatId: string
  text: string
  sender: 'user' | 'bia'
  time: string
  runId?: string
  responseTime?: string
  isCron?: boolean
  isMission?: boolean
  isSilent?: boolean
  isError?: boolean
}

export const mockMessages: Record<string, Message[]> = {
  '1': [
    { 
      id: 'm10', 
      chatId: '1', 
      text: 'Bia, o que sobrou da festa da Cecília no fim de semana passado?', 
      sender: 'user', 
      time: '10:35' 
    },
    { 
      id: 'm11', 
      chatId: '1', 
      text: 'Segundo a sua memória do evento (25/07/2026):\n- **Docinhos:** Sobrou aproximadamente a metade\n- **Pães de mel decorados:** Unidades ~5 não foram pra mesa\n- **Suco Aurora:** Sobrou inteiro\n- **Refrigerantes:** Acabaram todos!', 
      sender: 'bia', 
      time: '10:36',
      runId: 'mem-8812',
      responseTime: '1.4s'
    },
    { 
      id: 'm12', 
      chatId: '1', 
      text: 'Legal! Agora me ajude a procurar no Gmail se recebi o comprovante de matrícula da Cecília no Colégio Imaculada.', 
      sender: 'user', 
      time: '10:40' 
    },
    { 
      id: 'm13', 
      chatId: '1', 
      text: 'Encontrei o e-mail da secretaria do Colégio Imaculada enviado ontem às 16:20!\n\n**Assunto:** Confirmação de Matrícula 2026/2 - Cecília Tordin\n**Status:** Confirmada e paga.\n**Anexo:** `Comprovante_Matricula_Cecilia.pdf` registrado no seu Google Drive.', 
      sender: 'bia', 
      time: '10:42',
      runId: 'run-9941',
      responseTime: '3.8s'
    }
  ],
  '2': [
    {
      id: 'm20',
      chatId: '2',
      text: 'Oi Bia, avisa o Luiz que preciso da confirmação do horário do dentista dele.',
      sender: 'user',
      time: '09:14'
    },
    {
      id: 'm21',
      chatId: '2',
      text: 'Anotado! Enviei uma notificação no WhatsApp do Luiz e agendei a checagem no seu calendário.',
      sender: 'bia',
      time: '09:15',
      runId: 'run-4412',
      responseTime: '2.1s'
    }
  ],
  '3': [
    {
      id: 'm30',
      chatId: '3',
      text: 'Iniciando negociação autônoma via MissionAgent...',
      sender: 'bia',
      time: '08:20',
      isMission: true,
      runId: 'mis-7710',
      responseTime: '0.8s'
    },
    {
      id: 'm31',
      chatId: '3',
      text: 'Olá! Vi seu anúncio do Pneu Michelin no OLX. Aceita R$ 320 para retirar hoje em Alphaville?',
      sender: 'bia',
      time: '08:21',
      isMission: true
    },
    {
      id: 'm32',
      chatId: '3',
      text: 'Vendedor: Faço por R$ 350 o par se retirar hoje.',
      sender: 'user',
      time: '08:30'
    }
  ],
  '4': [
    {
      id: 'm40',
      chatId: '4',
      text: 'Rotina de Lembretes Diários (09:00)',
      sender: 'bia',
      time: '09:00',
      isCron: true,
      runId: 'cron-1102',
      responseTime: '1.1s'
    },
    {
      id: 'm41',
      chatId: '4',
      text: '📌 **Lembretes da Família Tordin para hoje:**\n- 14:00 - Aula de piano da Manuela 🎹\n- 18:30 - Treino de guitarra do Luiz 🎸',
      sender: 'bia',
      time: '09:00',
      isCron: true
    }
  ]
}

export type TraceNode = {
  id: string
  type: 'trigger' | 'supervisor' | 'agent' | 'output' | 'llm' | 'tool'
  title: string
  subtitle?: string
  tint: 'green' | 'purple' | 'orange' | 'cyan' | 'blue'
  tools?: { name: string, input: string, rawOutput: string }[]
  toolDetails?: { name: string, input: string, rawOutput: string }
  isLlmStep?: boolean
  isToolStep?: boolean
  timestamp?: string
  time?: string
}

export const mockTraces: Record<string, TraceNode[]> = {
  'run-9941': [
    {
      id: 'n1',
      type: 'trigger',
      title: 'Gatilho: Mensagem WhatsApp',
      subtitle: '"procurar no Gmail se recebi o comprovante de matrícula da Cecília no Colégio Imaculada"',
      tint: 'green'
    },
    {
      id: 'n2',
      type: 'supervisor',
      title: 'Supervisora (Bia Core)',
      subtitle: 'Decisão de Roteamento -> gmailAgent',
      tint: 'purple'
    },
    {
      id: 'n3',
      type: 'agent',
      title: 'gmailAgent (Especialista Workspace)',
      subtitle: 'Executando buscas na API do Gmail...',
      tint: 'orange',
      tools: [
        {
          name: 'gmail_search_messages',
          input: 'query: "Matrícula Cecília Colégio Imaculada", maxResults: 3',
          rawOutput: '{"messages": [{"id": "msg_8812a", "subject": "Confirmação de Matrícula 2026/2 - Cecília Tordin", "from": "secretaria@imaculada.edu.br", "date": "2026-07-29T16:20:00Z"}]}'
        },
        {
          name: 'gmail_get_attachment',
          input: 'messageId: "msg_8812a", attachmentId: "att_9912"',
          rawOutput: '{"fileName": "Comprovante_Matricula_Cecilia.pdf", "sizeBytes": 245120, "savedToDrive": true}'
        }
      ]
    },
    {
      id: 'n4',
      type: 'supervisor',
      title: 'Supervisora - Síntese Final',
      subtitle: 'nextAgent: "FINISH" (Garantia de alucinação zero)',
      tint: 'purple'
    },
    {
      id: 'n5',
      type: 'output',
      title: 'Saída WhatsApp (Baileys)',
      subtitle: 'Payload formatado enviado para Luiz Tordin',
      tint: 'green'
    }
  ],

  'mem-8812': [
    {
      id: 'n1',
      type: 'trigger',
      title: 'Gatilho: Pergunta sobre Memória',
      subtitle: '"o que sobrou da festa da Cecília no fim de semana passado?"',
      tint: 'green'
    },
    {
      id: 'n2',
      type: 'supervisor',
      title: 'Supervisora (Injeção de Perfil)',
      subtitle: 'Extraindo fatos do bia_memory.md',
      tint: 'purple'
    },
    {
      id: 'n3',
      type: 'supervisor',
      title: 'Supervisora - Resposta Direta',
      subtitle: 'nextAgent: "FINISH"',
      tint: 'purple'
    },
    {
      id: 'n4',
      type: 'output',
      title: 'Saída WhatsApp',
      subtitle: 'Resposta enviada ao usuário em 1.4s',
      tint: 'green'
    }
  ],

  'mis-7710': [
    {
      id: 'n1',
      type: 'trigger',
      title: 'Gatilho: Mission Manager',
      subtitle: 'Solicitação do Master para negociar Pneu OLX',
      tint: 'green'
    },
    {
      id: 'n2',
      type: 'supervisor',
      title: 'Supervisora -> missionAgent',
      subtitle: 'Análise de intenção de compra',
      tint: 'purple'
    },
    {
      id: 'n3',
      type: 'agent',
      title: 'missionAgent',
      subtitle: 'Iniciando fluxo de negociação autônoma',
      tint: 'orange',
      tools: [
        {
          name: 'start_mission',
          input: 'targetNumber: "5519988776655@s.whatsapp.net", goal: "Comprar pneu Michelin por no máximo R$ 350"',
          rawOutput: '{"missionId": "mis-7710", "status": "ACTIVE", "firstMessageSent": true}'
        }
      ]
    },
    {
      id: 'n4',
      type: 'output',
      title: 'Saída WhatsApp Target',
      subtitle: 'Primeira oferta enviada ao Vendedor',
      tint: 'green'
    }
  ],

  'cron-1102': [
    {
      id: 'n1',
      type: 'trigger',
      title: 'Gatilho: Cron Event (Node-Scheduler)',
      subtitle: 'Rotina ID #2: Lembretes Diários Família (09:00)',
      tint: 'green'
    },
    {
      id: 'n2',
      type: 'supervisor',
      title: 'Supervisora -> routineAgent',
      subtitle: 'Consulta de tarefas agendadas no SQLite',
      tint: 'purple'
    },
    {
      id: 'n3',
      type: 'agent',
      title: 'routineAgent',
      subtitle: 'Leitura da tabela `routines` no database.sqlite',
      tint: 'orange',
      tools: [
        {
          name: 'list_routines',
          input: 'date: "2026-07-30", activeOnly: true',
          rawOutput: '{"routines": [{"id": 2, "title": "Piano Manuela", "time": "14:00"}, {"id": 4, "title": "Guitarra Luiz", "time": "18:30"}]}'
        }
      ]
    },
    {
      id: 'n4',
      type: 'output',
      title: 'Saída WhatsApp Grupo Família',
      subtitle: 'Mensagem de resumo diário transmitida',
      tint: 'green'
    }
  ]
}

export const mockInspectors: Record<string, {
  context: string
  memory: string
  agentState: object
  modelOutput: object
  logs: string
}> = {
  'n3': {
    context: `Você é a Bia, assistente virtual pessoal e inteligente de Luiz Tordin.
Suas ferramentas disponíveis no especialista gmailAgent são:
- gmail_search_messages (query, maxResults)
- gmail_get_attachment (messageId, attachmentId)
- gmail_send_message (to, subject, body)`,
    memory: `# Informações Pessoais - Luiz Tordin
- Trabalho: iFood
- Bairro: Alphaville Dom Pedro - Campinas/SP
- Filhas: Manuela (7 anos, piano), Cecilia (3 anos, aniversário em julho)
- Escola: Colégio Imaculada`,
    agentState: {
      messages: [
        { role: "user", content: "me ajude a procurar no Gmail se recebi o comprovante de matrícula da Cecília no Colégio Imaculada" }
      ],
      currentSkill: "gmailAgent",
      userContext: {
        userId: "luiz_tordin",
        isTrustedChat: true,
        whatsappJid: "5519999999999@s.whatsapp.net"
      }
    },
    modelOutput: {
      thought: "O usuário deseja localizar um e-mail específico de comprovante de matrícula da filha Cecília no Colégio Imaculada. Vou executar uma busca refinada via gmail_search_messages.",
      tool_calls: [
        {
          name: "gmail_search_messages",
          args: { query: "Matrícula Cecília Colégio Imaculada", maxResults: 3 }
        }
      ]
    },
    logs: `[10:41:02.115] [INFO] [SUPERVISOR] Route decision: nextAgent -> gmailAgent
[10:41:02.120] [DEBUG] [GMAIL AGENT] Invocando ferramenta gmail_search_messages...
[10:41:03.450] [INFO] [GMAIL API] 200 OK. Encontradas 1 mensagem(ns).
[10:41:03.455] [DEBUG] [GMAIL AGENT] Invocando ferramenta gmail_get_attachment...
[10:41:04.102] [INFO] [DRIVE API] PDF salvo com sucesso em /GoogleDrive/Bia/Matriculas/`
  },
  
  'n2': {
    context: `Você é a Supervisora do sistema Bia. Analise a entrada do usuário e decida qual especialista acionar a seguir.
Resumo de Especialistas:
- searchAgent: Pesquisas na Web
- gmailAgent: Gestão de E-mails Gmail
- calendarAgent: Compromissos no Google Calendar
- missionAgent: Negociações e tarefas autônomas com terceiros
- routineAgent: Gerenciamento de tarefas e lembretes SQLite`,
    memory: `# Informações Pessoais - Luiz Tordin
- Trabalho: iFood
- Esposa: Luciana
- Filhas: Manuela, Cecilia`,
    agentState: {
      messages: [
        { role: "user", content: "me ajude a procurar no Gmail se recebi o comprovante de matrícula da Cecília no Colégio Imaculada" }
      ],
      nextAgent: null
    },
    modelOutput: {
      reasoning: "A solicitação envolve busca e leitura de e-mails na caixa de entrada do usuário.",
      nextAgent: "gmailAgent"
    },
    logs: `[10:40:59.800] [INFO] [LANGGRAPH] Node 'supervisor' iniciado.
[10:41:00.200] [INFO] [ROUTER] Intenção detectada com alta confiança (0.98): Gmail Workspaces.`
  }
}
