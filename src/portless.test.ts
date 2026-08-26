import { describe, expect, it } from "vitest"
import {
  buildPortlessServerCommand,
  isCanonicalPortlessUrl,
  type PortlessRuntime,
  parsePortlessProxyStatus,
  parsePortlessUrl
} from "./portless"

const runtime: PortlessRuntime = {
  name: "example-app",
  url: "https://example-app.localhost",
  command: "/usr/local/bin/portless"
}

describe("Portless integration", () => {
  it("extracts the canonical URL from Portless output", () => {
    expect(parsePortlessUrl("service URL: https://example.localhost\n")).toBe("https://example.localhost")
    expect(parsePortlessUrl("no URL here")).toBeNull()
  })

  it("only accepts genuinely port-free URLs as canonical", () => {
    expect(isCanonicalPortlessUrl("https://example.localhost")).toBe(true)
    expect(isCanonicalPortlessUrl("http://example.localhost")).toBe(true)
    expect(isCanonicalPortlessUrl("https://example.localhost:443")).toBe(false)
    expect(isCanonicalPortlessUrl("http://example.localhost:1355")).toBe(false)
    expect(isCanonicalPortlessUrl("not a URL")).toBe(false)
  })

  it("recognizes a persistent canonical HTTPS proxy", () => {
    const status = parsePortlessProxyStatus(
      "Proxy target: https://127.0.0.1\nok    Proxy is running on port 443.",
      "Installed: yes\nProxy on 443: responding"
    )

    expect(status).toMatchObject({
      serviceInstalled: true,
      proxyRunning: true,
      canonical: true,
      setupRequired: false
    })
  })

  it("requires setup for a high-port proxy", () => {
    const status = parsePortlessProxyStatus(
      "Proxy target: https://127.0.0.1:1355\nok    Proxy is responding on port 1355.",
      "Installed: no\nProxy on 443: not responding"
    )

    expect(status).toMatchObject({
      serviceInstalled: false,
      proxyRunning: true,
      canonical: false,
      setupRequired: true
    })
  })

  it("requires setup when the canonical proxy is not persistent", () => {
    const status = parsePortlessProxyStatus(
      "Proxy target: https://127.0.0.1\nok    Proxy is running on port 443.",
      "Installed: no\nProxy on 443: responding"
    )

    expect(status).toMatchObject({
      serviceInstalled: false,
      canonical: true,
      setupRequired: true
    })
  })

  it("wraps detected server commands with Portless", () => {
    const command = buildPortlessServerCommand(runtime, "bun run dev")

    expect(command).toContain("run --name 'example-app'")
    expect(command).toContain("-- bun run dev")
    expect(command).not.toContain("--app-port")
  })

  it("forwards explicit app ports", () => {
    const command = buildPortlessServerCommand(runtime, "bun run dev", { appPort: "4321" })

    expect(command).toContain("--app-port '4321'")
  })

  it("preserves custom shell commands as one child command", () => {
    const command = buildPortlessServerCommand(runtime, "API_MODE=local bun run dev", { customCommand: true })

    expect(command).toContain("-- sh -c 'API_MODE=local bun run dev'")
  })
})
