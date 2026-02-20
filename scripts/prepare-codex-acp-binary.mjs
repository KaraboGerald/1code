#!/usr/bin/env node

import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = path.join(__dirname, "..")
const BIN_DIR = path.join(ROOT_DIR, "resources", "bin")
const require = createRequire(import.meta.url)

function getPackageName() {
  const platform = process.platform
  const arch = process.arch

  if (platform === "darwin") {
    if (arch === "arm64") return "@zed-industries/codex-acp-darwin-arm64"
    if (arch === "x64") return "@zed-industries/codex-acp-darwin-x64"
  }

  if (platform === "linux") {
    if (arch === "arm64") return "@zed-industries/codex-acp-linux-arm64"
    if (arch === "x64") return "@zed-industries/codex-acp-linux-x64"
  }

  if (platform === "win32") {
    if (arch === "arm64") return "@zed-industries/codex-acp-win32-arm64"
    if (arch === "x64") return "@zed-industries/codex-acp-win32-x64"
  }

  throw new Error(`Unsupported platform/arch: ${platform}/${arch}`)
}

function main() {
  const binaryName = process.platform === "win32" ? "codex-acp.exe" : "codex-acp"
  const packageName = getPackageName()
  const sourcePath = require.resolve(`${packageName}/bin/${binaryName}`)

  const targetDir = path.join(BIN_DIR, `${process.platform}-${process.arch}`)
  const targetPath = path.join(targetDir, binaryName)

  fs.mkdirSync(targetDir, { recursive: true })
  fs.copyFileSync(sourcePath, targetPath)
  if (process.platform !== "win32") {
    fs.chmodSync(targetPath, 0o755)
  }

  console.log(`[codex-acp] prepared ${targetPath}`)
}

main()
