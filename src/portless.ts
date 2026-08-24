import { spawnSync } from "child_process"
import { accessSync, chmodSync, constants, existsSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const CANONICAL_PROXY_PORT = 443
const PORTLESS_SETUP_HINT = "Run `d3k portless setup` once, or run `portless proxy start --port 443` interactively."

export interface PortlessRuntime {
  name: string
  url: string
  command: string
}

export interface PortlessRuntimeResult {
  success: boolean
  runtime?: PortlessRuntime
  error?: string
}

function getRunnablePath(searchPath: string): string | null {
  if (!existsSync(searchPath)) {
    return null
  }
  if (process.platform === "win32") {
    return searchPath
  }
  try {
    accessSync(searchPath, constants.X_OK)
    return searchPath
  } catch {
    try {
      chmodSync(searchPath, 0o755)
      accessSync(searchPath, constants.X_OK)
      return searchPath
    } catch {
      return null
    }
  }
}

export function getPortlessCommand(): string {
  if (process.env.PORTLESS_PATH) {
    const runnablePath = getRunnablePath(process.env.PORTLESS_PATH)
    if (runnablePath) {
      return runnablePath
    }
  }

  const searchPaths: string[] = []

  try {
    const currentFile = fileURLToPath(import.meta.url)
    const currentDir = dirname(currentFile)

    if (currentDir.startsWith("/") || currentDir.match(/^[A-Z]:\\/i)) {
      searchPaths.push(
        join(dirname(currentDir), "node_modules", ".bin", "portless"),
        join(dirname(currentDir), "node_modules", "portless", "dist", "cli.js")
      )
    }
  } catch {
    // Ignore virtual paths when bundled by framework toolchains.
  }

  const home = homedir()
  const cwd = process.cwd()
  searchPaths.push(
    join(home, ".bun", "install", "global", "node_modules", "dev3000", "node_modules", ".bin", "portless"),
    join(home, ".bun", "install", "global", "node_modules", ".bin", "portless"),
    join(home, ".bun", "install", "global", "node_modules", "portless", "dist", "cli.js"),
    join(cwd, "node_modules", ".bin", "portless"),
    join(cwd, "node_modules", "portless", "dist", "cli.js"),
    join(cwd, "..", "node_modules", ".bin", "portless"),
    join(cwd, "..", "node_modules", "portless", "dist", "cli.js")
  )

  const globalNodeModules = [
    join("/usr", "local", "lib", "node_modules"),
    join("/opt", "homebrew", "lib", "node_modules")
  ]
  for (const root of globalNodeModules) {
    searchPaths.push(join(root, "dev3000", "node_modules", ".bin", "portless"))
    searchPaths.push(join(root, "portless", "dist", "cli.js"))
  }

  for (const searchPath of searchPaths) {
    const runnablePath = getRunnablePath(searchPath)
    if (runnablePath) {
      return runnablePath
    }
  }

  return "portless"
}

export function isPortlessInstalled(): boolean {
  try {
    const result = spawnSync(getPortlessCommand(), ["--version"], {
      stdio: "ignore",
      timeout: 5000
    })
    return result.status === 0
  } catch {
    return false
  }
}

function runPortlessCommand(args: string[], timeout: number = 30000): { success: boolean; output: string } {
  try {
    const result = spawnSync(getPortlessCommand(), args, {
      encoding: "utf8",
      timeout,
      // A pipe is intentionally non-interactive. Portless must never block an
      // agent-owned d3k startup waiting for sudo or certificate prompts.
      stdio: ["pipe", "pipe", "pipe"]
    })

    const output = `${result.stdout || ""}${result.stderr || ""}`.trim()
    return {
      success: result.status === 0,
      output
    }
  } catch (error) {
    return {
      success: false,
      output: error instanceof Error ? error.message : String(error)
    }
  }
}

export function parsePortlessUrl(output: string): string | null {
  return output.match(/https?:\/\/[^\s]+/)?.[0] || null
}

export function isCanonicalPortlessUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false
    }

    // URL normalizes explicit default ports away, so inspect the original
    // authority to ensure the user-facing URL truly contains no port number.
    return !/^https?:\/\/(?:\[[^\]]+\]|[^/?#:]+):\d+(?:[/?#]|$)/i.test(url)
  } catch {
    return false
  }
}

function getPortlessUrl(name: string): string | null {
  const result = runPortlessCommand(["get", name], 5000)
  return result.success ? parsePortlessUrl(result.output) : null
}

function isProxyRunning(): boolean {
  const result = runPortlessCommand(["doctor"], 10000)
  return /ok\s+Proxy is running\b/i.test(result.output)
}

function canStartCanonicalProxyNonInteractively(): boolean {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return true
  }
  if (process.getuid?.() === 0) {
    return true
  }

  try {
    const result = spawnSync("sudo", ["-n", "true"], {
      stdio: "ignore",
      timeout: 2000
    })
    return result.status === 0
  } catch {
    return false
  }
}

export function preparePortlessRuntime(name: string): PortlessRuntimeResult {
  if (process.env.PORTLESS === "0") {
    return { success: false, error: "Disabled by PORTLESS=0" }
  }

  if (!isPortlessInstalled()) {
    return { success: false, error: "Portless is not installed" }
  }

  if (!isProxyRunning()) {
    if (!canStartCanonicalProxyNonInteractively()) {
      return {
        success: false,
        error: `A port-free Portless proxy requires one-time setup. ${PORTLESS_SETUP_HINT}`
      }
    }

    // Requiring the canonical proxy port prevents Portless from silently
    // falling back to :1355 when elevation is unavailable. Piped stdio keeps
    // agent-owned startup non-interactive; users can perform setup once.
    const startResult = runPortlessCommand(["proxy", "start", "--port", String(CANONICAL_PROXY_PORT)])

    if (!startResult.success) {
      return {
        success: false,
        error: `A port-free Portless proxy is not available. ${PORTLESS_SETUP_HINT}`
      }
    }
  }

  const url = getPortlessUrl(name)
  if (!url) {
    return { success: false, error: "Portless did not return a URL" }
  }

  if (!isCanonicalPortlessUrl(url)) {
    return {
      success: false,
      error: `Portless returned ${url}, which includes an explicit port. ${PORTLESS_SETUP_HINT}`
    }
  }

  return {
    success: true,
    runtime: {
      name,
      url,
      command: getPortlessCommand()
    }
  }
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildPortlessServerCommand(
  runtime: PortlessRuntime,
  serverCommand: string,
  options: { appPort?: string; customCommand?: boolean } = {}
): string {
  const args = [shellQuote(runtime.command), "run", "--name", shellQuote(runtime.name)]
  if (options.appPort) {
    args.push("--app-port", shellQuote(options.appPort))
  }
  args.push("--")

  if (options.customCommand) {
    if (process.platform === "win32") {
      args.push("cmd.exe", "/d", "/s", "/c", shellQuote(serverCommand))
    } else {
      args.push("sh", "-c", shellQuote(serverCommand))
    }
  } else {
    args.push(serverCommand)
  }

  return args.join(" ")
}
