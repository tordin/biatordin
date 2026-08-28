import 'dotenv/config';
import { runSystemMaintenance } from '../src/utils/maintenance.js';

async function main() {
  const args = process.argv.slice(2);
  let retentionDays = 14;

  const daysIdx = args.findIndex(arg => arg === '--days' || arg === '-d');
  if (daysIdx !== -1 && args[daysIdx + 1]) {
    const parsed = parseInt(args[daysIdx + 1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      retentionDays = parsed;
    }
  }

  console.log(`🧹 [CLEAN_LOGS] Executando higienização do sistema com janela de ${retentionDays} dias...`);

  try {
    const report = await runSystemMaintenance({ retentionDays, vacuum: true });

    const initialTotalMB = ((report.jsonlInitialBytes + report.dbInitialBytes) / (1024 * 1024)).toFixed(2);
    const finalTotalMB = ((report.jsonlFinalBytes + report.dbFinalBytes) / (1024 * 1024)).toFixed(2);
    const freedMB = (((report.jsonlInitialBytes + report.dbInitialBytes) - (report.jsonlFinalBytes + report.dbFinalBytes)) / (1024 * 1024)).toFixed(2);

    console.log('\n=========================================');
    console.log('✅ Higienização concluída com sucesso!');
    console.log('=========================================');
    console.log(`• Duração: ${report.durationMs}ms`);
    console.log(`• Espaço total inicial: ${initialTotalMB} MB`);
    console.log(`• Espaço total final:   ${finalTotalMB} MB`);
    console.log(`• Espaço total liberado: ${freedMB} MB`);
    console.log('-----------------------------------------');
    console.log(`• JSONL Linhas: ${report.jsonlKeptLines} mantidas / ${report.jsonlTotalLines - report.jsonlKeptLines} removidas`);
    console.log(`• SQLite: ${report.dbCheckpointsRemoved} checkpoints e ${report.dbWritesRemoved} writes removidos`);
    console.log('=========================================\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Erro durante a higienização:', error);
    process.exit(1);
  }
}

main();
