import { defineNitroPlugin } from "nitropack/runtime";
import { assertNoRetiredEnvironmentVariables } from "../services/settings/retired-environment.js";

export default defineNitroPlugin(async () => {
  assertNoRetiredEnvironmentVariables(process.env);

  // Skip in serverless — Vercel handles the workflow runtime automatically
  if (process.env.VERCEL || process.env.SERVERLESS) return;

  // Polyfill for @workflow/world-local bug where bundled fallback emits 'bundled'
  // which fails parseVersion() semver regex.
  const origMatch = String.prototype.match;
  // eslint-disable-next-line no-extend-native
  String.prototype.match = function (matcher: any) {
    if (
      this.valueOf() === "bundled" &&
      matcher instanceof RegExp &&
      matcher.source.startsWith("^(\\d+)")
    ) {
      const res = ["4.8.0", "4", "8", "0", undefined];
      return res as unknown as RegExpMatchArray;
    }
    return origMatch.apply(this, arguments as any);
  };

  // For local dev and self-hosted node-server deployments: boot the workflow
  // world. This defaults to the filesystem-backed world-local (Workflow DevKit's
  // own default for `next dev`/`next start`).
  try {
    const { getWorld } = await import("workflow/runtime");
    await getWorld().start?.();
    console.log("[workflow-world] Workflow world started successfully.");
  } catch (err) {
    console.warn("Workflow world not started:", (err as Error).message);
  }

  // Optional in-process cron scheduler for self-hosted / Docker deployments
  // where Vercel Cron is not invoking /cron/poll and /cron/harness-capabilities.
  if (process.env.CRON_IN_PROCESS === "true") {
    try {
      const { Cron } = await import("croner");
      const triggerLocalCron = async (path: string) => {
        const port = process.env.NITRO_PORT || process.env.PORT || "3000";
        const secret = process.env.CRON_SECRET;
        const headers: Record<string, string> = {};
        if (secret) {
          headers.authorization = `Bearer ${secret}`;
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}${path}`, {
            method: "GET",
            headers,
          });
          if (!response.ok) {
            console.warn(
              `[in-process-cron] ${path} returned HTTP ${response.status}`,
            );
          }
        } catch (err) {
          console.warn(
            `[in-process-cron] ${path} request failed:`,
            (err as Error).message,
          );
        }
      };

      const pollJob = new Cron("*/15 * * * *", { protect: true }, () =>
        triggerLocalCron("/cron/poll"),
      );
      const capabilitiesJob = new Cron("*/30 * * * *", { protect: true }, () =>
        triggerLocalCron("/cron/harness-capabilities"),
      );
      void pollJob;
      void capabilitiesJob;

      console.log(
        "[in-process-cron] Scheduled /cron/poll (*/15 * * * *) and /cron/harness-capabilities (*/30 * * * *).",
      );
    } catch (err) {
      console.warn(
        "[in-process-cron] Failed to start scheduler:",
        (err as Error).message,
      );
    }
  }
});
