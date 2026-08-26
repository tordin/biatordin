#!/usr/bin/env bash

# Script de Inicialização do Bia Debugger
# Função: Verifica se há processos ativos do debugger, encerra-os e inicia uma nova instância.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEBUGGER_DIR="$(cd "$SCRIPT_DIR/../bia-debugger" && pwd)"

cd "$DEBUGGER_DIR"

echo "🔍 Verificando se existem outros processos ativos do Debugger..."

# Função para encontrar PIDs de processos associados ao bia-debugger
find_debugger_pids() {
    ps auxww | grep -E '(node|next|npm)' | grep -i 'bia-debugger' | grep -v 'grep' | grep -v 'start-debugger\.sh' | awk '{print $2}' || true
}

PIDS=$(find_debugger_pids)

if [ -n "$PIDS" ]; then
    echo "⚠️  Encontrado(s) processo(s) ativo(s) do Debugger (PID: $(echo $PIDS | tr '\n' ' '))."
    echo "🛑 Encerrando processos anteriores..."
    
    # Tenta término amigável (SIGTERM)
    for pid in $PIDS; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -15 "$pid" 2>/dev/null || true
        fi
    done

    # Aguarda até 3 segundos para finalização limpa
    sleep 3

    # Verifica se algum processo ainda sobreviveu
    REMAINING_PIDS=$(find_debugger_pids)
    if [ -n "$REMAINING_PIDS" ]; then
        echo "⚡ Encerrando forçadamente (SIGKILL) processos remanescentes (PID: $(echo $REMAINING_PIDS | tr '\n' ' '))..."
        for pid in $REMAINING_PIDS; do
            kill -9 "$pid" 2>/dev/null || true
        done
        sleep 1
    fi
    echo "✅ Processos anteriores encerrados com sucesso."
else
    echo "ℹ️  Nenhum outro processo ativo do Debugger foi encontrado."
fi

echo "🚀 Iniciando o Bia Debugger (npm run dev)..."
exec npm run dev
