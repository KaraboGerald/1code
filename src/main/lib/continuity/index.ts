import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import simpleGit from "simple-git"
import { and, desc, eq } from "drizzle-orm"
import {
  chats,
  continuityArtifact,
  continuityFileCache,
  continuityPackCache,
  continuitySearchCache,
  continuitySettings,
  continuityState,
  getDatabase,
  subChats,
} from "../db"
import {
  getContinuityBudgetProfile,
  getContinuityGovernorCapabilities,
  getContinuityMode,
  getContinuityTokenMode,
  getDefaultContinuityArtifactPolicy,
  getDefaultContinuityMemoryBranch,
  type ContinuityArtifactPolicy,
  type ContinuityTokenMode,
} from "../config"
import {
  trackContinuityGovernorAction,
  trackContinuityPackMetrics,
  trackContinuitySafeguard,
} from "../analytics"

const execFileAsync = promisify(execFile)

type ProviderKind = "claude" | "codex"
type ChatMode = "plan" | "agent"

type ContinuityInput = {
  subChatId: string
  cwd: string
  projectPath?: string
  prompt: string
  mode: ChatMode
  provider: ProviderKind
}

type ContinuityOutput = {
  prompt: string
  cacheHit: boolean
  injectedBytes: number
  reusedPercent: number
  stateIds: {
    anchorPackId: string
    contextPackId: string
    deltaPackId: string
    planContractId: string | null
  }
}

type RunOutcomeInput = {
  subChatId: string
  cwd: string
  projectPath?: string
  provider: ProviderKind
  mode: ChatMode
  prompt: string
  assistantResponse: string
  injectedBytes?: number
  wasError?: boolean
}

type GovernorAction = "ok" | "snapshot" | "rehydrate"

type GovernorDecision = {
  action: GovernorAction
  reasons: string[]
}

type SafeguardSettings = {
  artifactPolicy: ContinuityArtifactPolicy
  autoCommitToMemoryBranch: boolean
  tokenMode: ContinuityTokenMode
  memoryBranch: string
}

type RepoState = {
  headCommit: string
  changedFiles: string[]
  changedFilesHash: string
}

type CachedSearchResult = {
  timestamp: number
  files: string[]
}

type CachedFileSummary = {
  summary: string
}

type SubChatState = {
  lastChangedFilesHash: string
}
type ProtocolState = {
  lastCacheKey: string | null
}

const SEARCH_TTL_MS = 60_000
const MAX_SUMMARY_LINES = 12
const DEVLOG_DIFF_THRESHOLD = 120
const DEVLOG_FILE_THRESHOLD = 6
const REHYDRATE_TURN_THRESHOLD = 12
const SNAPSHOT_TURN_THRESHOLD = 7
const REHYDRATE_BYTES_THRESHOLD = 150_000
const SNAPSHOT_BYTES_THRESHOLD = 90_000
const REHYDRATE_FILES_THRESHOLD = 18
const SNAPSHOT_FILES_THRESHOLD = 10
const REHYDRATE_DIFF_THRESHOLD = 280
const SNAPSHOT_DIFF_THRESHOLD = 160
const REHYDRATE_ELAPSED_MS = 50 * 60 * 1000
const SNAPSHOT_ELAPSED_MS = 25 * 60 * 1000

const STOPWORDS = new Set([
  "the",
  "this",
  "that",
  "with",
  "from",
  "into",
  "about",
  "would",
  "could",
  "should",
  "there",
  "their",
  "your",
  "need",
  "have",
  "please",
  "just",
  "when",
  "what",
  "where",
  "which",
  "while",
  "after",
  "before",
  "code",
  "repo",
  "project",
])

const BOUNDARY_MODULE_PREFIXES = [
  "src/main/lib/trpc/",
  "src/main/lib/db/",
  "src/main/lib/continuity/",
  "src/main/lib/plugins/",
  "src/main/lib/mcp-",
  "src/main/lib/oauth",
  "src/main/lib/git/",
]

function sha(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

function normalizePrompt(prompt: string): string {
  return prompt.trim().toLowerCase().replace(/\s+/g, " ")
}

function extractKeywords(prompt: string): string[] {
  const parts = prompt
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/g)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && !STOPWORDS.has(part))

  return [...new Set(parts)].slice(0, 6)
}

function clampByBytes(value: string, maxBytes: number): string {
  const byteLength = Buffer.byteLength(value, "utf8")
  if (byteLength <= maxBytes) return value
  let current = value
  while (Buffer.byteLength(current, "utf8") > maxBytes && current.length > 0) {
    current = current.slice(0, Math.floor(current.length * 0.85))
  }
  return current
}

function buildFileSummary(filePath: string, content: string): string {
  const lines = content.split("\n")
  const exportLike = lines
    .filter((line) =>
      /^(export\s+|module\.exports|class\s+\w+|function\s+\w+|interface\s+\w+|type\s+\w+)/.test(
        line.trim(),
      ),
    )
    .slice(0, MAX_SUMMARY_LINES)
    .map((line) => line.trim())

  const firstNonEmpty = lines.find((line) => line.trim().length > 0)?.trim() || ""
  const details: string[] = [
    `file: ${filePath}`,
    `lines: ${lines.length}`,
  ]

  if (firstNonEmpty) {
    details.push(`first_line: ${firstNonEmpty.slice(0, 120)}`)
  }
  if (exportLike.length > 0) {
    details.push(`symbols: ${exportLike.join(" | ").slice(0, 900)}`)
  }

  return details.join("\n")
}

class ContinuityService {
  private searchCache = new Map<string, CachedSearchResult>()
  private fileSummaryCache = new Map<string, CachedFileSummary>()
  private contextPackCache = new Map<string, string>()
  private subChatState = new Map<string, SubChatState>()
  private protocolState = new Map<string, ProtocolState>()

  async apply(input: ContinuityInput): Promise<ContinuityOutput> {
    const continuityMode = getContinuityMode()
    const tokenMode = await this.getConfiguredTokenMode()
    const budget = getContinuityBudgetProfile(tokenMode)
    const fallbackStateIds = {
      anchorPackId: "none",
      contextPackId: "none",
      deltaPackId: "none",
      planContractId: input.mode === "plan" ? sha(normalizePrompt(input.prompt)) : null,
    }
    if (continuityMode === "off") {
      return {
        prompt: input.prompt,
        cacheHit: false,
        injectedBytes: 0,
        reusedPercent: 100,
        stateIds: fallbackStateIds,
      }
    }

    const repoRoot = input.projectPath || input.cwd
    const taskFingerprint = sha(normalizePrompt(input.prompt))
    const repoState = await this.getRepoState(repoRoot)
    const cacheKey = [
      taskFingerprint,
      repoState.changedFilesHash,
      repoState.headCommit,
      input.provider,
      input.mode,
      String(budget.maxPackBytes),
    ].join(":")
    const objectiveLine = input.prompt.split("\n").find((line) => line.trim().length > 0)?.trim() || input.prompt.trim()
    const anchorPackId = sha(`${repoRoot}:anchor:${repoState.headCommit}`)
    const contextPackId = sha(cacheKey)
    const planContractId = input.mode === "plan" ? sha(normalizePrompt(input.prompt)) : null

    const cached = await this.getCachedPack(cacheKey)
    const deltaPack = await this.buildDeltaPack(input.subChatId, repoRoot, repoState, input.prompt)
    const deltaPackId = sha(deltaPack)
    const stateIds = { anchorPackId, contextPackId, deltaPackId, planContractId }
    const previous = this.protocolState.get(input.subChatId)
    const canUseDeltaOnly = previous?.lastCacheKey === cacheKey

    const deltaOnlyEnvelope = [
      "[1CODE_CONTINUITY_STATE_IDS]",
      `anchorPackId: ${anchorPackId}`,
      `contextPackId: ${contextPackId}`,
      `deltaPackId: ${deltaPackId}`,
      `planContractId: ${planContractId || "none"}`,
      "",
      "[1CODE_CONTINUITY_DELTA]",
      deltaPack,
      "",
      "[1CODE_OBJECTIVE]",
      clampByBytes(objectiveLine, 240),
      "",
      "[1CODE_USER_REQUEST]",
    ].join("\n")

    if (cached) {
      const fullPrompt = `${cached}\n\n${input.prompt}`
      const deltaOnlyPrompt = `${deltaOnlyEnvelope}\n\n${input.prompt}`
      const selectedPrompt = canUseDeltaOnly ? deltaOnlyPrompt : fullPrompt
      const injectedBytes = Math.max(
        Buffer.byteLength(selectedPrompt, "utf8") -
          Buffer.byteLength(input.prompt, "utf8"),
        0,
      )
      const reusedPercent = canUseDeltaOnly ? 95 : 75
      trackContinuityPackMetrics({
        provider: input.provider,
        mode: input.mode,
        cacheHit: true,
        packBytes: Buffer.byteLength(selectedPrompt, "utf8"),
        injectedBytes,
        reusedPercent,
      })
      this.protocolState.set(input.subChatId, { lastCacheKey: cacheKey })
      if (continuityMode === "passive") {
        return {
          prompt: input.prompt,
          cacheHit: true,
          injectedBytes: 0,
          reusedPercent,
          stateIds,
        }
      }
      return {
        prompt: selectedPrompt,
        cacheHit: true,
        injectedBytes,
        reusedPercent,
        stateIds,
      }
    }

    const anchorPack = await this.buildAnchorPack(repoRoot)
    const contextPack = await this.buildContextPack(
      repoRoot,
      repoState,
      input.prompt,
      budget,
    )
    const planContract =
      input.mode === "plan"
        ? `id: ${planContractId}\nmax_steps: 6\nobjective: ${clampByBytes(objectiveLine, 200)}\nformat: compact-structured`
        : ""

    const composite = [
      "[1CODE_CONTINUITY_STATE_IDS]",
      `anchorPackId: ${anchorPackId}`,
      `contextPackId: ${contextPackId}`,
      `deltaPackId: ${deltaPackId}`,
      `planContractId: ${planContractId || "none"}`,
      "",
      "[1CODE_CONTINUITY_ANCHOR]",
      anchorPack,
      "",
      "[1CODE_CONTINUITY_CONTEXT]",
      contextPack,
      "",
      ...(input.mode === "plan"
        ? ["[1CODE_PLAN_CONTRACT]", planContract, ""]
        : []),
      "[1CODE_CONTINUITY_DELTA]",
      deltaPack,
      "",
      "[1CODE_OBJECTIVE]",
      clampByBytes(objectiveLine, 240),
      "",
      "[1CODE_USER_REQUEST]",
    ].join("\n")

    const budgeted = clampByBytes(composite, budget.maxPackBytes)
    await this.storeCachedPack({
      key: cacheKey,
      taskFingerprint,
      changedFilesHash: repoState.changedFilesHash,
      headCommit: repoState.headCommit,
      provider: input.provider,
      mode: input.mode,
      budgetBytes: budget.maxPackBytes,
      pack: budgeted,
    })
    await this.storeSubChatState(input.subChatId, repoState.changedFilesHash, budgeted)
    this.protocolState.set(input.subChatId, { lastCacheKey: cacheKey })
    const injectedBytes = Math.max(
      Buffer.byteLength(`${budgeted}\n\n${input.prompt}`, "utf8") -
        Buffer.byteLength(input.prompt, "utf8"),
      0,
    )
    const reusedPercent = 35
    trackContinuityPackMetrics({
      provider: input.provider,
      mode: input.mode,
      cacheHit: false,
      packBytes: Buffer.byteLength(budgeted, "utf8"),
      injectedBytes,
      reusedPercent,
    })
    if (continuityMode === "passive") {
      return {
        prompt: input.prompt,
        cacheHit: false,
        injectedBytes: 0,
        reusedPercent,
        stateIds,
      }
    }

    return {
      prompt: `${budgeted}\n\n${input.prompt}`,
      cacheHit: false,
      injectedBytes,
      reusedPercent,
      stateIds,
    }
  }

  async recordRunOutcome(input: RunOutcomeInput): Promise<GovernorDecision> {
    const continuityMode = getContinuityMode()
    if (continuityMode === "off") {
      return { action: "ok", reasons: [] }
    }

    const repoRoot = input.projectPath || input.cwd
    const repoState = await this.getRepoState(repoRoot)
    const diffStats = await this.getDiffStats(repoRoot)
    const current = await this.getPersistedState(input.subChatId)
    const nextTurns = current.turnsSinceSnapshot + 1
    const nextInjectedBytes =
      current.totalInjectedBytes + Math.max(input.injectedBytes || 0, 0)
    const now = Date.now()
    const safeguardSettings =
      continuityMode === "active" ? await this.getSafeguardSettings() : null
    const autoCommitPolicy =
      continuityMode === "active" && safeguardSettings
        ? await this.assessAutoCommitPolicy(repoRoot, safeguardSettings)
        : null

    const governorDecision = this.decideGovernor({
      turnsSinceSnapshot: nextTurns,
      totalInjectedBytes: nextInjectedBytes,
      changedFilesCount: repoState.changedFiles.length,
      diffLines: diffStats.totalLines,
      elapsedSinceSnapshotMs: current.lastSnapshotAt
        ? now - current.lastSnapshotAt.getTime()
        : REHYDRATE_ELAPSED_MS + 1,
    })
    const capabilities = getContinuityGovernorCapabilities()
    const effectiveGovernorAction: GovernorAction =
      governorDecision.action === "rehydrate" && !capabilities.rehydrateEnabled
        ? capabilities.snapshotEnabled
          ? "snapshot"
          : "ok"
        : governorDecision.action === "snapshot" && !capabilities.snapshotEnabled
          ? "ok"
          : governorDecision.action

    const meaningful = this.detectMeaningfulEvents({
      repoState,
      diffLines: diffStats.totalLines,
      assistantResponse: input.assistantResponse,
      wasError: !!input.wasError,
    })

    if (continuityMode === "active" && meaningful.devlog && safeguardSettings && autoCommitPolicy) {
      await this.writeArtifactIfNew({
        subChatId: input.subChatId,
        type: "devlog",
        eventFingerprint: meaningful.eventFingerprint,
        content: [
          `provider: ${input.provider}`,
          `mode: ${input.mode}`,
          `commit: ${repoState.headCommit}`,
          `changed_files: ${repoState.changedFiles.slice(0, 24).join(", ") || "none"}`,
          `diff_lines: ${diffStats.totalLines}`,
          `signals: ${meaningful.reasons.join("; ")}`,
          `artifact_policy: ${safeguardSettings.artifactPolicy}`,
          `memory_branch: ${safeguardSettings.memoryBranch}`,
          `auto_commit_eligible: ${String(autoCommitPolicy.allowed)}`,
          "",
          `prompt: ${clampByBytes(input.prompt, 900)}`,
          "",
          `assistant_summary: ${clampByBytes(input.assistantResponse, 1500)}`,
        ].join("\n"),
      })
    }

    if (continuityMode === "active" && meaningful.adr) {
      await this.writeArtifactIfNew({
        subChatId: input.subChatId,
        type: "adr",
        eventFingerprint: `${meaningful.eventFingerprint}:adr`,
        content: [
          "status: draft",
          `context: boundary module touch detected (${meaningful.boundaryFiles.slice(0, 12).join(", ")})`,
          "decision: TBD",
          "consequences: TBD",
          "",
          `prompt: ${clampByBytes(input.prompt, 900)}`,
        ].join("\n"),
      })
    }

    if (continuityMode === "active" && meaningful.rejectedApproach) {
      await this.writeArtifactIfNew({
        subChatId: input.subChatId,
        type: "rejected-approach",
        eventFingerprint: `${meaningful.eventFingerprint}:rejected`,
        content: [
          `reason: ${meaningful.rejectedReason}`,
          `prompt: ${clampByBytes(input.prompt, 900)}`,
          `assistant_summary: ${clampByBytes(input.assistantResponse, 1200)}`,
        ].join("\n"),
      })
    }

    await this.persistGovernorState({
      subChatId: input.subChatId,
      lastChangedFilesHash: repoState.changedFilesHash,
      turnsSinceSnapshot:
        effectiveGovernorAction === "ok" ? nextTurns : 0,
      totalInjectedBytes:
        effectiveGovernorAction === "ok" ? nextInjectedBytes : 0,
      lastSnapshotAt:
        effectiveGovernorAction === "ok"
          ? current.lastSnapshotAt
          : new Date(now),
    })

    if (continuityMode === "active" && effectiveGovernorAction !== "ok" && safeguardSettings && autoCommitPolicy) {
      await this.writeArtifactIfNew({
        subChatId: input.subChatId,
        type: "devlog",
        eventFingerprint: `${input.subChatId}:${now}:${effectiveGovernorAction}`,
        content: [
          `governor_action: ${effectiveGovernorAction}`,
          `reasons: ${governorDecision.reasons.join("; ")}`,
          `changed_files: ${repoState.changedFiles.slice(0, 20).join(", ") || "none"}`,
          `diff_lines: ${diffStats.totalLines}`,
          `artifact_policy: ${safeguardSettings.artifactPolicy}`,
          `auto_commit_eligible: ${String(autoCommitPolicy.allowed)}`,
        ].join("\n"),
      })
    }

    trackContinuityGovernorAction({
      provider: input.provider,
      mode: input.mode,
      action: effectiveGovernorAction,
      reasonsCount: governorDecision.reasons.length,
    })

    if (continuityMode === "active" && autoCommitPolicy?.requested && safeguardSettings) {
      trackContinuitySafeguard({
        action: autoCommitPolicy.allowed
          ? "auto-commit-allowed"
          : "auto-commit-blocked",
        branch: autoCommitPolicy.currentBranch,
        memoryBranch: safeguardSettings.memoryBranch,
      })

      if (!autoCommitPolicy.allowed) {
        await this.writeArtifactIfNew({
          subChatId: input.subChatId,
          type: "devlog",
          eventFingerprint: `${repoState.headCommit}:auto-commit-blocked:${autoCommitPolicy.currentBranch}`,
          content: [
            "safeguard: auto commit blocked",
            `current_branch: ${autoCommitPolicy.currentBranch}`,
            `required_memory_branch: ${safeguardSettings.memoryBranch}`,
            "policy: feature branches are protected from automatic continuity commits",
          ].join("\n"),
        })
      }
    }

    if (continuityMode === "active" && effectiveGovernorAction === "rehydrate") {
      await this.executeRehydrate({
        subChatId: input.subChatId,
        prompt: input.prompt,
        reasons: governorDecision.reasons,
      })
    }

    return {
      action: effectiveGovernorAction,
      reasons: governorDecision.reasons,
    }
  }

  private async getCachedPack(key: string): Promise<string | null> {
    const hot = this.contextPackCache.get(key)
    if (hot) return hot

    try {
      const db = getDatabase()
      const row = db
        .select({ pack: continuityPackCache.pack })
        .from(continuityPackCache)
        .where(eq(continuityPackCache.key, key))
        .get()
      if (!row?.pack) return null
      this.contextPackCache.set(key, row.pack)
      return row.pack
    } catch {
      return null
    }
  }

  private async storeCachedPack(input: {
    key: string
    taskFingerprint: string
    changedFilesHash: string
    headCommit: string
    provider: ProviderKind
    mode: ChatMode
    budgetBytes: number
    pack: string
  }): Promise<void> {
    this.contextPackCache.set(input.key, input.pack)
    try {
      const db = getDatabase()
      db.insert(continuityPackCache)
        .values({
          key: input.key,
          taskFingerprint: input.taskFingerprint,
          changedFilesHash: input.changedFilesHash,
          headCommit: input.headCommit,
          provider: input.provider,
          mode: input.mode,
          budgetBytes: input.budgetBytes,
          pack: input.pack,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: continuityPackCache.key,
          set: {
            pack: input.pack,
            taskFingerprint: input.taskFingerprint,
            changedFilesHash: input.changedFilesHash,
            headCommit: input.headCommit,
            provider: input.provider,
            mode: input.mode,
            budgetBytes: input.budgetBytes,
            updatedAt: new Date(),
          },
        })
        .run()
    } catch {
      // Best effort cache persistence.
    }
  }

  private async getRepoState(repoRoot: string): Promise<RepoState> {
    try {
      const git = simpleGit(repoRoot)
      const [headCommit, status] = await Promise.all([
        git.revparse(["HEAD"]),
        git.status(),
      ])
      const changedFiles = [...new Set(status.files.map((file) => file.path))].sort()
      return {
        headCommit: headCommit.trim(),
        changedFiles,
        changedFilesHash: sha(changedFiles.join("\n")),
      }
    } catch {
      return {
        headCommit: "no-git",
        changedFiles: [],
        changedFilesHash: "no-changes",
      }
    }
  }

  private async buildAnchorPack(repoRoot: string): Promise<string> {
    const anchorFiles = ["AGENTS.md", "CLAUDE.md", "README.md"]
    const parts: string[] = []

    for (const relativePath of anchorFiles) {
      const fullPath = path.join(repoRoot, relativePath)
      try {
        const content = await fs.readFile(fullPath, "utf8")
        const trimmed = clampByBytes(content, 3_000)
        parts.push(`## ${relativePath}\n${trimmed}`)
      } catch {
        // Missing file is fine.
      }
    }

    if (parts.length === 0) {
      return "No anchor files found."
    }

    return parts.join("\n\n")
  }

  private async buildContextPack(
    repoRoot: string,
    repoState: RepoState,
    prompt: string,
    budget: {
      maxContextFiles: number
      maxContextSummaryBytes: number
      maxFileReadBytes: number
    },
  ): Promise<string> {
    const keywords = extractKeywords(prompt)
    const searchHits = await this.searchRelevantFiles(repoRoot, keywords, repoState.headCommit)

    const candidateFiles = [
      ...repoState.changedFiles.slice(0, 4),
      ...searchHits,
    ]
    const uniqueFiles = [...new Set(candidateFiles)].slice(0, budget.maxContextFiles)
    if (uniqueFiles.length === 0) {
      return "No relevant files identified."
    }

    const summaries: string[] = []
    let totalBytes = 0
    for (const filePath of uniqueFiles) {
      const summary = await this.readSummary(
        repoRoot,
        filePath,
        budget.maxFileReadBytes,
      )
      if (summary) {
        const nextBytes = Buffer.byteLength(summary, "utf8")
        if (totalBytes + nextBytes > budget.maxContextSummaryBytes) {
          break
        }
        summaries.push(summary)
        totalBytes += nextBytes
      }
    }

    return summaries.join("\n\n---\n\n")
  }

  private async buildDeltaPack(
    subChatId: string,
    repoRoot: string,
    repoState: RepoState,
    prompt: string,
  ): Promise<string> {
    const diffSnippet = await this.getDiffSnippet(repoRoot)
    const failingTestDigest = await this.getLatestFailingTestDigest(subChatId)
    const objective = prompt.split("\n").find((line) => line.trim().length > 0)?.trim() || prompt.trim()
    const previous = await this.getSubChatState(subChatId)
    if (!previous) {
      return [
        "first_run: true",
        `objective: ${clampByBytes(objective, 200)}`,
        `changed_files: ${repoState.changedFiles.slice(0, 20).join(", ") || "none"}`,
        `failing_test_digest: ${failingTestDigest || "none"}`,
        "",
        "[DIFF_SNIPPET]",
        diffSnippet || "none",
      ].join("\n")
    }

    if (previous.lastChangedFilesHash === repoState.changedFilesHash) {
      return [
        "repo_delta: unchanged",
        `objective: ${clampByBytes(objective, 200)}`,
        `failing_test_digest: ${failingTestDigest || "none"}`,
      ].join("\n")
    }

    return [
      "repo_delta: changed",
      `objective: ${clampByBytes(objective, 200)}`,
      `changed_files: ${repoState.changedFiles.slice(0, 20).join(", ") || "none"}`,
      `failing_test_digest: ${failingTestDigest || "none"}`,
      "",
      "[DIFF_SNIPPET]",
      diffSnippet || "none",
    ].join("\n")
  }

  private async getSubChatState(subChatId: string): Promise<SubChatState | null> {
    const hot = this.subChatState.get(subChatId)
    if (hot) return hot

    try {
      const db = getDatabase()
      const row = db
        .select({ lastChangedFilesHash: continuityState.lastChangedFilesHash })
        .from(continuityState)
        .where(eq(continuityState.subChatId, subChatId))
        .get()
      if (!row) return null
      const state: SubChatState = { lastChangedFilesHash: row.lastChangedFilesHash }
      this.subChatState.set(subChatId, state)
      return state
    } catch {
      return null
    }
  }

  private async storeSubChatState(
    subChatId: string,
    changedFilesHash: string,
    pack: string,
  ): Promise<void> {
    this.subChatState.set(subChatId, { lastChangedFilesHash: changedFilesHash })
    try {
      const db = getDatabase()
      db.insert(continuityState)
        .values({
          subChatId,
          lastChangedFilesHash: changedFilesHash,
          turnsSinceSnapshot: 0,
          totalInjectedBytes: Buffer.byteLength(pack, "utf8"),
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: continuityState.subChatId,
          set: {
            lastChangedFilesHash: changedFilesHash,
            totalInjectedBytes: Buffer.byteLength(pack, "utf8"),
            updatedAt: new Date(),
          },
        })
        .run()
    } catch {
      // Best effort state persistence.
    }
  }

  private async getPersistedState(subChatId: string): Promise<{
    turnsSinceSnapshot: number
    totalInjectedBytes: number
    lastSnapshotAt: Date | null
  }> {
    try {
      const db = getDatabase()
      const row = db
        .select({
          turnsSinceSnapshot: continuityState.turnsSinceSnapshot,
          totalInjectedBytes: continuityState.totalInjectedBytes,
          lastSnapshotAt: continuityState.lastSnapshotAt,
        })
        .from(continuityState)
        .where(eq(continuityState.subChatId, subChatId))
        .get()
      return {
        turnsSinceSnapshot: row?.turnsSinceSnapshot ?? 0,
        totalInjectedBytes: row?.totalInjectedBytes ?? 0,
        lastSnapshotAt: row?.lastSnapshotAt ?? null,
      }
    } catch {
      return {
        turnsSinceSnapshot: 0,
        totalInjectedBytes: 0,
        lastSnapshotAt: null,
      }
    }
  }

  private async persistGovernorState(input: {
    subChatId: string
    lastChangedFilesHash: string
    turnsSinceSnapshot: number
    totalInjectedBytes: number
    lastSnapshotAt: Date | null
  }): Promise<void> {
    this.subChatState.set(input.subChatId, {
      lastChangedFilesHash: input.lastChangedFilesHash,
    })
    try {
      const db = getDatabase()
      db.insert(continuityState)
        .values({
          subChatId: input.subChatId,
          lastChangedFilesHash: input.lastChangedFilesHash,
          turnsSinceSnapshot: input.turnsSinceSnapshot,
          totalInjectedBytes: input.totalInjectedBytes,
          lastSnapshotAt: input.lastSnapshotAt,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: continuityState.subChatId,
          set: {
            lastChangedFilesHash: input.lastChangedFilesHash,
            turnsSinceSnapshot: input.turnsSinceSnapshot,
            totalInjectedBytes: input.totalInjectedBytes,
            lastSnapshotAt: input.lastSnapshotAt,
            updatedAt: new Date(),
          },
        })
        .run()
    } catch {
      // Best effort persistence.
    }
  }

  private async getSafeguardSettings(): Promise<SafeguardSettings> {
    const fallback: SafeguardSettings = {
      artifactPolicy: getDefaultContinuityArtifactPolicy(),
      autoCommitToMemoryBranch: false,
      tokenMode: getContinuityTokenMode(),
      memoryBranch: getDefaultContinuityMemoryBranch(),
    }

    try {
      const db = getDatabase()
      const row = db
        .select({
          artifactPolicy: continuitySettings.artifactPolicy,
          autoCommitToMemoryBranch: continuitySettings.autoCommitToMemoryBranch,
          tokenMode: continuitySettings.tokenMode,
          memoryBranch: continuitySettings.memoryBranch,
        })
        .from(continuitySettings)
        .where(eq(continuitySettings.id, "singleton"))
        .get()

      if (!row) {
        db.insert(continuitySettings)
          .values({
            id: "singleton",
            artifactPolicy: fallback.artifactPolicy,
            autoCommitToMemoryBranch: false,
            tokenMode: fallback.tokenMode,
            memoryBranch: fallback.memoryBranch,
            updatedAt: new Date(),
          })
          .run()
        return fallback
      }

      return {
        artifactPolicy:
          row.artifactPolicy === "auto-write-memory-branch"
            ? "auto-write-memory-branch"
            : "auto-write-manual-commit",
        autoCommitToMemoryBranch: !!row.autoCommitToMemoryBranch,
        tokenMode:
          row.tokenMode === "low" ||
          row.tokenMode === "normal" ||
          row.tokenMode === "debug"
            ? row.tokenMode
            : fallback.tokenMode,
        memoryBranch: row.memoryBranch || fallback.memoryBranch,
      }
    } catch {
      return fallback
    }
  }

  private async getConfiguredTokenMode(): Promise<ContinuityTokenMode> {
    const fallback = getContinuityTokenMode()
    try {
      const db = getDatabase()
      const row = db
        .select({ tokenMode: continuitySettings.tokenMode })
        .from(continuitySettings)
        .where(eq(continuitySettings.id, "singleton"))
        .get()
      if (
        row?.tokenMode === "low" ||
        row?.tokenMode === "normal" ||
        row?.tokenMode === "debug"
      ) {
        return row.tokenMode
      }
      return fallback
    } catch {
      return fallback
    }
  }

  private async assessAutoCommitPolicy(
    repoRoot: string,
    settings: SafeguardSettings,
  ): Promise<{
    requested: boolean
    allowed: boolean
    currentBranch: string
  }> {
    const requested =
      settings.artifactPolicy === "auto-write-memory-branch" &&
      settings.autoCommitToMemoryBranch

    let currentBranch = "unknown"
    try {
      const git = simpleGit(repoRoot)
      currentBranch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim()
    } catch {
      currentBranch = "unknown"
    }

    if (!requested) {
      return { requested: false, allowed: false, currentBranch }
    }

    // Hard guard: auto-commit is only allowed on the configured memory branch.
    const allowed = currentBranch === settings.memoryBranch
    return { requested: true, allowed, currentBranch }
  }

  private detectMeaningfulEvents(input: {
    repoState: RepoState
    diffLines: number
    assistantResponse: string
    wasError: boolean
  }): {
    devlog: boolean
    adr: boolean
    rejectedApproach: boolean
    rejectedReason: string
    reasons: string[]
    boundaryFiles: string[]
    eventFingerprint: string
  } {
    const reasons: string[] = []
    if (input.diffLines >= DEVLOG_DIFF_THRESHOLD) {
      reasons.push(`diff>${DEVLOG_DIFF_THRESHOLD}`)
    }
    if (input.repoState.changedFiles.length >= DEVLOG_FILE_THRESHOLD) {
      reasons.push(`changed_files>${DEVLOG_FILE_THRESHOLD}`)
    }

    const responseLower = input.assistantResponse.toLowerCase()
    const rejectedReason = input.wasError
      ? "run-error"
      : "direction-change"
    const rejectedApproach =
      input.wasError ||
      responseLower.includes("instead") ||
      responseLower.includes("alternative approach") ||
      responseLower.includes("pivot")

    const boundaryFiles = input.repoState.changedFiles.filter((filePath) =>
      BOUNDARY_MODULE_PREFIXES.some((prefix) => filePath.startsWith(prefix)),
    )
    const adr = boundaryFiles.length > 0
    if (adr) {
      reasons.push("boundary-modules-touched")
    }
    if (input.wasError) {
      reasons.push("run-error")
    }

    const devlog = reasons.length > 0
    const eventFingerprint = sha(
      [
        input.repoState.headCommit,
        input.repoState.changedFilesHash,
        String(input.diffLines),
        String(input.wasError),
        responseLower.slice(0, 160),
      ].join(":"),
    )

    return {
      devlog,
      adr,
      rejectedApproach,
      rejectedReason,
      reasons,
      boundaryFiles,
      eventFingerprint,
    }
  }

  private decideGovernor(input: {
    turnsSinceSnapshot: number
    totalInjectedBytes: number
    changedFilesCount: number
    diffLines: number
    elapsedSinceSnapshotMs: number
  }): GovernorDecision {
    const reasons: string[] = []
    const severeReasons: string[] = []

    if (input.turnsSinceSnapshot >= SNAPSHOT_TURN_THRESHOLD) {
      reasons.push("turn-pressure")
    }
    if (input.totalInjectedBytes >= SNAPSHOT_BYTES_THRESHOLD) {
      reasons.push("context-pressure")
    }
    if (input.changedFilesCount >= SNAPSHOT_FILES_THRESHOLD) {
      reasons.push("scope-pressure")
    }
    if (input.diffLines >= SNAPSHOT_DIFF_THRESHOLD) {
      reasons.push("diff-pressure")
    }
    if (input.elapsedSinceSnapshotMs >= SNAPSHOT_ELAPSED_MS) {
      reasons.push("time-pressure")
    }

    if (input.turnsSinceSnapshot >= REHYDRATE_TURN_THRESHOLD) {
      severeReasons.push("turn-pressure-high")
    }
    if (input.totalInjectedBytes >= REHYDRATE_BYTES_THRESHOLD) {
      severeReasons.push("context-pressure-high")
    }
    if (input.changedFilesCount >= REHYDRATE_FILES_THRESHOLD) {
      severeReasons.push("scope-pressure-high")
    }
    if (input.diffLines >= REHYDRATE_DIFF_THRESHOLD) {
      severeReasons.push("diff-pressure-high")
    }
    if (input.elapsedSinceSnapshotMs >= REHYDRATE_ELAPSED_MS) {
      severeReasons.push("time-pressure-high")
    }

    if (severeReasons.length >= 2) {
      return { action: "rehydrate", reasons: severeReasons }
    }
    if (reasons.length >= 2) {
      return { action: "snapshot", reasons }
    }
    return { action: "ok", reasons: [] }
  }

  private async getDiffSnippet(repoRoot: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoRoot, "diff", "--unified=1", "--", "."],
        {
          timeout: 7_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      )
      return clampByBytes(stdout.trim(), 4_000)
    } catch {
      return ""
    }
  }

  private async getLatestFailingTestDigest(subChatId: string): Promise<string> {
    try {
      const db = getDatabase()
      const row = db
        .select({ messages: subChats.messages })
        .from(subChats)
        .where(eq(subChats.id, subChatId))
        .get()
      if (!row?.messages) return ""
      const parsed = JSON.parse(row.messages) as Array<{
        role?: string
        parts?: Array<{ type?: string; text?: string }>
      }>
      const textLines: string[] = []
      for (const message of parsed.slice(-12)) {
        if (!Array.isArray(message.parts)) continue
        for (const part of message.parts) {
          if (part?.type === "text" && typeof part.text === "string") {
            textLines.push(part.text)
          }
        }
      }
      const joined = textLines.join("\n")
      const failureLines = joined
        .split("\n")
        .filter((line) =>
          /fail|failed|error|exception|assert/i.test(line),
        )
        .slice(-40)
      if (failureLines.length === 0) return ""
      return clampByBytes(failureLines.join("\n"), 2_000)
    } catch {
      return ""
    }
  }

  private async getDiffStats(repoRoot: string): Promise<{ totalLines: number }> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoRoot, "diff", "--numstat"],
        {
          timeout: 7_000,
          maxBuffer: 1024 * 1024,
        },
      )
      const totalLines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .reduce((sum, line) => {
          const [addedRaw, removedRaw] = line.split("\t")
          const added = Number(addedRaw)
          const removed = Number(removedRaw)
          return sum + (Number.isFinite(added) ? added : 0) + (Number.isFinite(removed) ? removed : 0)
        }, 0)
      return { totalLines }
    } catch {
      return { totalLines: 0 }
    }
  }

  private async writeArtifactIfNew(input: {
    subChatId: string
    type: "devlog" | "adr" | "rejected-approach"
    eventFingerprint: string
    content: string
  }): Promise<void> {
    try {
      const db = getDatabase()
      const existing = db
        .select({
          id: continuityArtifact.id,
          provenanceJson: continuityArtifact.provenanceJson,
        })
        .from(continuityArtifact)
        .where(
          and(
            eq(continuityArtifact.subChatId, input.subChatId),
            eq(continuityArtifact.type, input.type),
          ),
        )
        .orderBy(desc(continuityArtifact.createdAt))
        .limit(12)
        .all()

      const alreadyExists = existing.some((row) => {
        try {
          const parsed = JSON.parse(row.provenanceJson || "{}") as {
            eventFingerprint?: string
          }
          return parsed.eventFingerprint === input.eventFingerprint
        } catch {
          return false
        }
      })
      if (alreadyExists) return

      db.insert(continuityArtifact)
        .values({
          subChatId: input.subChatId,
          type: input.type,
          content: input.content,
          status: "draft",
          provenanceJson: JSON.stringify({
            eventFingerprint: input.eventFingerprint,
            createdBy: "continuity-service",
          }),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run()
    } catch {
      // Best effort persistence.
    }
  }

  private async searchRelevantFiles(
    repoRoot: string,
    keywords: string[],
    headCommit: string,
  ): Promise<string[]> {
    if (keywords.length === 0) return []
    const keywordQuery = keywords.join(",")
    const cacheKey = `${repoRoot}:${headCommit}:${keywordQuery}`
    const cached = this.searchCache.get(cacheKey)
    if (cached && Date.now() - cached.timestamp < SEARCH_TTL_MS) {
      return cached.files
    }

    const persistedSearch = await this.getPersistedSearch(cacheKey)
    if (persistedSearch) {
      this.searchCache.set(cacheKey, persistedSearch)
      return persistedSearch.files
    }

    const files = await this.listFiles(repoRoot)
    const scored = files
      .map((filePath) => {
        const lower = filePath.toLowerCase()
        let score = 0
        for (const keyword of keywords) {
          if (lower.includes(keyword)) score += 3
          if (path.basename(lower).includes(keyword)) score += 4
        }
        return { filePath, score }
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 24)
      .map((entry) => entry.filePath)

    const persisted: CachedSearchResult = { timestamp: Date.now(), files: scored }
    this.searchCache.set(cacheKey, persisted)
    await this.storePersistedSearch(cacheKey, repoRoot, keywordQuery, headCommit, persisted)
    return scored
  }

  private async getPersistedSearch(cacheKey: string): Promise<CachedSearchResult | null> {
    try {
      const db = getDatabase()
      const row = db
        .select({
          resultJson: continuitySearchCache.resultJson,
          updatedAt: continuitySearchCache.updatedAt,
        })
        .from(continuitySearchCache)
        .where(eq(continuitySearchCache.key, cacheKey))
        .get()
      if (!row?.resultJson || !row.updatedAt) return null
      const ageMs = Date.now() - row.updatedAt.getTime()
      if (ageMs > SEARCH_TTL_MS) return null
      const parsed = JSON.parse(row.resultJson) as { files?: unknown }
      if (!Array.isArray(parsed.files)) return null
      return {
        timestamp: row.updatedAt.getTime(),
        files: parsed.files.filter((entry): entry is string => typeof entry === "string"),
      }
    } catch {
      return null
    }
  }

  private async storePersistedSearch(
    cacheKey: string,
    repoRoot: string,
    keywordQuery: string,
    headCommit: string,
    result: CachedSearchResult,
  ): Promise<void> {
    try {
      const db = getDatabase()
      db.insert(continuitySearchCache)
        .values({
          key: cacheKey,
          repoRoot,
          query: keywordQuery,
          commitHash: headCommit,
          scope: "repo",
          resultJson: JSON.stringify({ files: result.files }),
          updatedAt: new Date(result.timestamp),
        })
        .onConflictDoUpdate({
          target: continuitySearchCache.key,
          set: {
            repoRoot,
            query: keywordQuery,
            commitHash: headCommit,
            resultJson: JSON.stringify({ files: result.files }),
            updatedAt: new Date(result.timestamp),
          },
        })
        .run()
    } catch {
      // Best effort persistence.
    }
  }

  private async listFiles(repoRoot: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync("rg", ["--files"], {
        cwd: repoRoot,
        timeout: 8_000,
        maxBuffer: 6 * 1024 * 1024,
      })
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    } catch {
      return []
    }
  }

  private async readSummary(
    repoRoot: string,
    relativePath: string,
    maxFileReadBytes: number,
  ): Promise<string | null> {
    const fullPath = path.join(repoRoot, relativePath)
    try {
      const stat = await fs.stat(fullPath)
      if (!stat.isFile() || stat.size > maxFileReadBytes) {
        return null
      }
      const content = await fs.readFile(fullPath, "utf8")
      const contentHash = sha(content)
      const summaryHash = sha(`${repoRoot}:${relativePath}:${contentHash}`)
      const cached = this.fileSummaryCache.get(summaryHash)
      if (cached) {
        return cached.summary
      }

      const persisted = await this.getPersistedSummary(summaryHash)
      if (persisted) {
        this.fileSummaryCache.set(summaryHash, { summary: persisted })
        return persisted
      }

      const summary = buildFileSummary(relativePath, content)
      this.fileSummaryCache.set(summaryHash, { summary })
      await this.storePersistedSummary(summaryHash, repoRoot, relativePath, contentHash, summary)
      return summary
    } catch {
      return null
    }
  }

  private async getPersistedSummary(key: string): Promise<string | null> {
    try {
      const db = getDatabase()
      const row = db
        .select({ summary: continuityFileCache.summary })
        .from(continuityFileCache)
        .where(eq(continuityFileCache.key, key))
        .get()
      return row?.summary || null
    } catch {
      return null
    }
  }

  private async storePersistedSummary(
    key: string,
    repoRoot: string,
    filePath: string,
    contentHash: string,
    summary: string,
  ): Promise<void> {
    try {
      const db = getDatabase()
      db.insert(continuityFileCache)
        .values({
          key,
          repoRoot,
          filePath,
          contentHash,
          summary,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: continuityFileCache.key,
          set: {
            summary,
            contentHash,
            updatedAt: new Date(),
          },
        })
        .run()
    } catch {
      // Best effort persistence.
    }
  }

  private async executeRehydrate(input: {
    subChatId: string
    prompt: string
    reasons: string[]
  }): Promise<void> {
    try {
      const db = getDatabase()
      const subChat = db
        .select({
          id: subChats.id,
          chatId: subChats.chatId,
          mode: subChats.mode,
        })
        .from(subChats)
        .where(eq(subChats.id, input.subChatId))
        .get()
      if (!subChat) return

      const artifacts = db
        .select({
          type: continuityArtifact.type,
          content: continuityArtifact.content,
          createdAt: continuityArtifact.createdAt,
        })
        .from(continuityArtifact)
        .where(eq(continuityArtifact.subChatId, input.subChatId))
        .orderBy(desc(continuityArtifact.createdAt))
        .limit(6)
        .all()

      const carryLines = artifacts.map((artifact) => {
        const firstLine = artifact.content.split("\n").find((line) => line.trim().length > 0) || ""
        return `- ${artifact.type}: ${clampByBytes(firstLine, 180)}`
      })

      const structuredState = [
        "[1CODE_CONTINUITY_REHYDRATE]",
        `mode: ${subChat.mode}`,
        `reasons: ${input.reasons.join("; ") || "governor-pressure"}`,
        ...carryLines,
        "",
        `latest_user_prompt: ${clampByBytes(input.prompt, 600)}`,
      ].join("\n")

      const compactedMessages = [
        {
          id: crypto.randomUUID(),
          role: "assistant",
          parts: [{ type: "text", text: structuredState }],
          metadata: {
            continuityRehydrate: true,
            createdAt: new Date().toISOString(),
          },
        },
      ]

      db.update(subChats)
        .set({
          sessionId: null,
          streamId: null,
          messages: JSON.stringify(compactedMessages),
          updatedAt: new Date(),
        })
        .where(eq(subChats.id, input.subChatId))
        .run()

      db.update(chats)
        .set({ updatedAt: new Date() })
        .where(eq(chats.id, subChat.chatId))
        .run()
    } catch {
      // Best effort rehydrate flow.
    }
  }
}

export const continuityService = new ContinuityService()
