#!/usr/bin/env bash

# Script de Inicialização da Bia
# Função: Verifica se há processos ativos da Bia, encerra-os e inicia uma nova instância.

# REMOVIDO: set -e (isso estava causando falhas silenciosas quando o grep não achava nada)

# Diretório raiz do projeto
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "🔍 Verificando se existem outros processos ativos da Bia..."

# Função para encontrar PIDs de processos node/tsx associados a biatordin
find_bia_pids() {
    PIDS_PS=$(ps auxww | grep -E '(node|tsx|npm)' | grep -i 'biatordin' | grep -v 'grep' | grep -v 'start\.sh' | awk '{print $2}' || true)
    PIDS_LSOF=$(lsof -t "$PROJECT_DIR/database.sqlite" 2>/dev/null || true)
    echo -e "$PIDS_PS\n$PIDS_LSOF" | sort -u | grep -v '^$' || true
}

PIDS=$(find_bia_pids)

if [ -n "$PIDS" ]; then
    echo "⚠️  Encontrado(s) processo(s) ativo(s) da Bia (PID: $(echo $PIDS | tr '\n' ' '))."
    echo "🛑 Encerrando processos anteriores..."
    
    # Tenta término amigável (SIGTERM)
    for pid in $PIDS; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -15 "$pid" 2>/dev/null || true
        fi
    done

    # Aguarda até 3 segundos para finalização limpa das conexões e banco de dados
    sleep 3

    # Verifica se algum processo ainda sobreviveu
    REMAINING_PIDS=$(find_bia_pids)
    if [ -n "$REMAINING_PIDS" ]; then
        echo "⚡ Encerrando forçadamente (SIGKILL) processos remanescentes (PID: $(echo $REMAINING_PIDS | tr '\n' ' '))..."
        for pid in $REMAINING_PIDS; do
            kill -9 "$pid" 2>/dev/null || true
        done
        sleep 1
    fi
    echo "✅ Processos anteriores encerrados com sucesso."
else
    echo "ℹ️  Nenhum outro processo ativo da Bia foi encontrado."
fi

echo "🚀 Iniciando a Bia (npm run dev)..."
exec npm run dev
