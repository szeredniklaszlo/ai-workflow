/**
 * Runtime selector for the sandbox SDK.
 *
 * Defaults to @vercel/sandbox so Vercel deployments and unit test suites that
 * mock @vercel/sandbox behave identically without configuration. When
 * SANDBOX_KIND=docker is set in self-hosted deployments, loads the local
 * Docker CLI-backed implementation instead.
 */
export async function loadSandboxSdk(): Promise<typeof import("@vercel/sandbox")> {
  if (process.env.SANDBOX_KIND === "docker") {
    return (await import("./docker-sandbox.js")) as unknown as typeof import("@vercel/sandbox");
  }
  return import("@vercel/sandbox");
}
