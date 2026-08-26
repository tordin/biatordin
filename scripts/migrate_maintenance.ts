import { createTracker } from '../src/memory/trackers.js';
import { deactivateRoutine, saveRoutine } from '../src/memory/routines.js';
import sqlite3 from 'sqlite3';

const chatJid = "120363425678591898@g.us"; // Based on the sqlite dump for routines 344 and 345

async function run() {
  console.log("Iniciando migração do Plano de Manutenção...");

  const data = {
    items: [
      { nome: "Caixa de gordura", frequencia: "6 meses", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/02/2027" },
      { nome: "Caixas d'água", frequencia: "1 ano", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2027" },
      { nome: "Calhas e rufos (antes das chuvas)", frequencia: "6 meses", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/02/2027" },
      { nome: "Painéis solares fotovoltaicos", frequencia: "1 ano", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2027" },
      { nome: "Placas de aquecimento solar", frequencia: "1 ano", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2027" },
      { nome: "Boiler de água quente", frequencia: "2 anos", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2028" },
      { nome: "Lavagem de piso externo", frequencia: "1 ano", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2027" },
      { nome: "Impermeabilização/Resina externa", frequencia: "3 anos", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2029" },
      { nome: "Ar-condicionado (higienização)", frequencia: "1 ano", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2027" },
      { nome: "Dedetização e controle de cupim", frequencia: "1 ano", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2027" },
      { nome: "Pressurizador e bombas d'água", frequencia: "1 ano", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2027" },
      { nome: "Quadro elétrico (reaperto de bornes)", frequencia: "2 anos", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2028" },
      { nome: "Revisão de telhado e vedações", frequencia: "2 anos", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2028" },
      { nome: "Pintura e selamento da fachada", frequencia: "5 anos", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2031" },
      { nome: "Piscina (bomba)", frequencia: "1 ano", ultimo_reparo: "10/08/2026", proximo_vencimento: "10/08/2027" }
    ]
  };

  try {
    // Cria o novo tracker
    const tracker = await createTracker(
      chatJid,
      "Plano de Manutenção da Casa",
      "Controla as datas de manutenção periódica da casa. O json tem um array 'items' com 'nome', 'frequencia', 'ultimo_reparo' e 'proximo_vencimento'. Atualize as datas quando uma manutenção for feita.",
      JSON.stringify(data, null, 2)
    );
    console.log("Tracker criado com sucesso! ID:", tracker.id);

    // Cria a nova rotina enxuta
    const novaRotina = await saveRoutine(
      chatJid,
      "0 9 * * 1", // Toda segunda as 9h
      "Leia o Tracker 'Plano de Manutenção da Casa'. Avalie se algum 'proximo_vencimento' está expirado (já passou da data de hoje) ou vence nos próximos 30 dias. Se houver algum, me envie um resumo. Se não houver, fique em silêncio absoluto."
    );
    console.log("Nova rotina inteligente criada! ID:", novaRotina.id);

    console.log("Deletando rotinas antigas (344, 345 e 346)...");
    const db = new sqlite3.Database('database.sqlite');
    db.run("DELETE FROM routines WHERE id IN (344, 345, 346)", (err) => {
        if (err) console.error(err);
        else console.log("Rotinas antigas apagadas com sucesso!");
    });
    
  } catch (err) {
    console.error("Erro na migração:", err);
  }
}

run();
