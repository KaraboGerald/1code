import { eq } from "drizzle-orm"
import { z } from "zod"
import { continuitySettings, getDatabase } from "../../db"
import {
  getDefaultContinuityArtifactPolicy,
  getDefaultContinuityMemoryBranch,
  getContinuityTokenMode,
} from "../../config"
import { publicProcedure, router } from "../index"

const continuityPolicySchema = z.enum([
  "auto-write-manual-commit",
  "auto-write-memory-branch",
])
const continuityTokenModeSchema = z.enum(["low", "normal", "debug"])

function ensureSettingsRow() {
  const db = getDatabase()
  const existing = db
    .select()
    .from(continuitySettings)
    .where(eq(continuitySettings.id, "singleton"))
    .get()

  if (existing) {
    return existing
  }

  const inserted = db
    .insert(continuitySettings)
    .values({
      id: "singleton",
      artifactPolicy: getDefaultContinuityArtifactPolicy(),
      autoCommitToMemoryBranch: false,
      tokenMode: getContinuityTokenMode(),
      memoryBranch: getDefaultContinuityMemoryBranch(),
      updatedAt: new Date(),
    })
    .returning()
    .get()

  return inserted
}

export const continuitySettingsRouter = router({
  get: publicProcedure.query(() => ensureSettingsRow()),

  update: publicProcedure
    .input(
      z.object({
        artifactPolicy: continuityPolicySchema.optional(),
        autoCommitToMemoryBranch: z.boolean().optional(),
        tokenMode: continuityTokenModeSchema.optional(),
        memoryBranch: z.string().min(1).optional(),
      }),
    )
    .mutation(({ input }) => {
      const db = getDatabase()
      const current = ensureSettingsRow()
      const next = {
        artifactPolicy: input.artifactPolicy ?? current.artifactPolicy,
        autoCommitToMemoryBranch:
          input.autoCommitToMemoryBranch ?? current.autoCommitToMemoryBranch,
        tokenMode: input.tokenMode ?? current.tokenMode ?? getContinuityTokenMode(),
        memoryBranch: (input.memoryBranch ?? current.memoryBranch).trim(),
      }

      return db
        .update(continuitySettings)
        .set({
          artifactPolicy: next.artifactPolicy,
          autoCommitToMemoryBranch: next.autoCommitToMemoryBranch,
          tokenMode: next.tokenMode,
          memoryBranch: next.memoryBranch || getDefaultContinuityMemoryBranch(),
          updatedAt: new Date(),
        })
        .where(eq(continuitySettings.id, "singleton"))
        .returning()
        .get()
    }),
})
