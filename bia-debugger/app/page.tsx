"use client"
import { useState } from "react"
import { AnimatePresence } from "framer-motion"
import { Topbar } from "@/components/Topbar"
import { PanelSidebar } from "@/components/PanelSidebar"
import { PanelChat } from "@/components/PanelChat"
import { PanelTrace } from "@/components/PanelTrace"
import { PanelInspector } from "@/components/PanelInspector"

export default function Dashboard() {
  const [selectedChatId, setSelectedChatId] = useState<string>("1")
  const [traceRunId, setTraceRunId] = useState<string | null>(null)
  const [inspectorNodeId, setInspectorNodeId] = useState<string | null>(null)

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background text-foreground">
      <Topbar 
        chatId={selectedChatId} 
        runId={traceRunId} 
        nodeId={inspectorNodeId} 
      />
      <div className="flex flex-1 overflow-hidden relative">
        <PanelSidebar 
          selectedId={selectedChatId} 
          onSelect={(id) => {
            setSelectedChatId(id)
            setTraceRunId(null)
            setInspectorNodeId(null)
          }} 
        />
        
        <PanelChat 
          chatId={selectedChatId} 
          onOpenTrace={(runId) => setTraceRunId(runId)}
          traceOpen={!!traceRunId}
        />

        <AnimatePresence>
          {traceRunId && (
            <PanelTrace 
              runId={traceRunId} 
              onClose={() => {
                setTraceRunId(null)
                setInspectorNodeId(null)
              }}
              onSelectNode={(nodeId) => setInspectorNodeId(nodeId)}
              inspectorOpen={!!inspectorNodeId}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {inspectorNodeId && (
            <PanelInspector 
              nodeId={inspectorNodeId} 
              onClose={() => setInspectorNodeId(null)} 
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
