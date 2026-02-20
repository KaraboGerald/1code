"use client"

import { memo } from "react"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "../../../components/ui/hover-card"
import { cn } from "../../../lib/utils"

export interface AgentMessageMetadata {
  sessionId?: string
  totalCostUsd?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  finalTextId?: string
  durationMs?: number
  resultSubtype?: string
  continuityCacheHit?: boolean
  continuityInjectedBytes?: number
  continuityReusedPercent?: number
  continuityStateIds?: {
    anchorPackId?: string
    contextPackId?: string
    deltaPackId?: string
    planContractId?: string | null
  }
  runBudgetProfile?: string
  runMaxThinkingTokens?: number
  runMaxTurns?: number
  runMaxBudgetUsd?: number
  runMcpMode?: string
  historyCompacted?: boolean
}

interface AgentMessageUsageProps {
  metadata?: AgentMessageMetadata
  isStreaming?: boolean
  isMobile?: boolean
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return tokens.toString()
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }
  const seconds = ms / 1000
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds % 60)
  return `${minutes}m ${remainingSeconds}s`
}

export const AgentMessageUsage = memo(function AgentMessageUsage({
  metadata,
  isStreaming = false,
  isMobile = false,
}: AgentMessageUsageProps) {
  if (!metadata || isStreaming) return null

  const {
    inputTokens = 0,
    outputTokens = 0,
    totalTokens = 0,
    durationMs,
    resultSubtype,
    continuityCacheHit,
    continuityInjectedBytes = 0,
    continuityReusedPercent,
    runBudgetProfile,
    runMaxThinkingTokens,
    runMaxTurns,
    runMaxBudgetUsd,
    runMcpMode,
    historyCompacted,
  } = metadata

  const hasUsage =
    inputTokens > 0 ||
    outputTokens > 0 ||
    continuityInjectedBytes > 0 ||
    typeof continuityReusedPercent === "number"

  if (!hasUsage) return null

  const displayTokens = totalTokens || inputTokens + outputTokens
  const compactBadgeText =
    displayTokens > 0
      ? formatTokens(displayTokens)
      : typeof continuityReusedPercent === "number"
        ? `ctx ${Math.round(continuityReusedPercent)}%`
        : "ctx"

  return (
    <HoverCard openDelay={400} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          tabIndex={-1}
          className={cn(
            "h-5 px-1.5 flex items-center text-[10px] rounded-md",
            "text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/50",
            "transition-[background-color,transform] duration-150 ease-out",
          )}
        >
          <span className="font-mono">{compactBadgeText}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        sideOffset={4}
        align="end"
        className="w-auto pt-2 px-2 pb-0 shadow-sm rounded-lg border-border/50 overflow-hidden"
      >
        <div className="space-y-1.5 pb-2">
          {/* Status & Duration group */}
          {(resultSubtype || (durationMs !== undefined && durationMs > 0)) && (
            <div className="space-y-1">
              {resultSubtype && (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Status:</span>
                  <span className="font-mono text-foreground">
                    {resultSubtype === "success" ? "Success" : "Failed"}
                  </span>
                </div>
              )}

              {durationMs !== undefined && durationMs > 0 && (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Duration:</span>
                  <span className="font-mono text-foreground">
                    {formatDuration(durationMs)}
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Tokens group */}
          <div className="flex justify-between text-xs gap-4 pt-1.5 mt-1 border-t border-border/50">
            <span className="text-muted-foreground">Tokens:</span>
            <span className="font-mono font-medium text-foreground">
              {displayTokens.toLocaleString()}
            </span>
          </div>

          {(typeof continuityReusedPercent === "number" ||
            continuityInjectedBytes > 0) && (
            <div className="space-y-1 pt-1 border-t border-border/50">
              {typeof continuityReusedPercent === "number" && (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Context reuse:</span>
                  <span className="font-mono text-foreground">
                    {Math.round(continuityReusedPercent)}%
                  </span>
                </div>
              )}
              {continuityInjectedBytes > 0 && (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Injected bytes:</span>
                  <span className="font-mono text-foreground">
                    {continuityInjectedBytes.toLocaleString()}
                  </span>
                </div>
              )}
              {typeof continuityCacheHit === "boolean" && (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Pack cache:</span>
                  <span className="font-mono text-foreground">
                    {continuityCacheHit ? "hit" : "miss"}
                  </span>
                </div>
              )}
            </div>
          )}

          {(runMaxThinkingTokens || runMaxTurns || runMaxBudgetUsd) && (
            <div className="space-y-1 pt-1 border-t border-border/50">
              <div className="flex justify-between text-xs gap-4">
                <span className="text-muted-foreground">Run policy:</span>
                <span className="font-mono text-foreground">
                  {(runBudgetProfile || "default").replace(/-/g, " ")}
                </span>
              </div>
              {runMaxThinkingTokens ? (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Think cap:</span>
                  <span className="font-mono text-foreground">
                    {runMaxThinkingTokens.toLocaleString()}
                  </span>
                </div>
              ) : null}
              {runMaxTurns ? (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Turn cap:</span>
                  <span className="font-mono text-foreground">
                    {runMaxTurns}
                  </span>
                </div>
              ) : null}
              {runMaxBudgetUsd ? (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">Budget cap:</span>
                  <span className="font-mono text-foreground">
                    ${runMaxBudgetUsd.toFixed(2)}
                  </span>
                </div>
              ) : null}
              {runMcpMode ? (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">MCP mode:</span>
                  <span className="font-mono text-foreground">{runMcpMode}</span>
                </div>
              ) : null}
              {historyCompacted ? (
                <div className="flex justify-between text-xs gap-4">
                  <span className="text-muted-foreground">History:</span>
                  <span className="font-mono text-foreground">compacted</span>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
})
