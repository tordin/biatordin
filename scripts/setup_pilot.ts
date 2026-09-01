import 'dotenv/config';
import { getDb } from '../src/memory/db.js';
import { initContextDocumentsTable, saveContextDocument } from '../src/memory/contextDocuments.js';

const db = getDb();

async function run() {
  await initContextDocumentsTable();
  const topicId = '42e6deb8-a4be-454d-9904-026288a9811d'; // Cardápios semanais
  const title = 'Cardápios semanais';
  
  const content = `## Repertório da Bá
- **Oba:** Frango grelhado, legumes assados, salada caprese.
- **Tauste:** Peixe (tilápia), arroz integral, purê de abóbora.
- (13 outros preparos conhecidos extraídos do histórico de janeiro a agosto de 2026)

## Regras Ativas
- **Toda segunda:** 8 preparos fixos (ex: arroz, feijão, frango, carne moída).
- **Luiz:** Gosta de tilápia.
- **Cecília:** Sem mamão / sem frutas laxativas.
- **Quinoa:** Sem pepino.

## Histórico Recente
- **Semana 10/08:** Teve bastante peixe, Cecília aceitou bem.
- **Semana 17/08:** Carne moída com batata foi sucesso.`;

  console.log("Salvando documento de contexto piloto...");
  await saveContextDocument(topicId, title, content);
  
  // Create Routine
  // Precisamos do JID do grupo Casa 130. Como não tenho o JID exato, 
  // vou colocar um placeholder ou tentar achar no banco.
  
  console.log("Para a rotina, por favor crie via chat usando o routineAgent, ou ajuste o chatJid.");
  // db.run("INSERT INTO routines (chatJid, cronExpression, prompt, isActive, topicId) VALUES (?, ?, ?, 1, ?)", 
  //   ["<JID_CASA_130>", "0 9 * * 6", "Gere a lista do cardápio da próxima semana baseada nas regras, histórico e repertório.", topicId]);
  
  console.log("Feito!");
}

run();
