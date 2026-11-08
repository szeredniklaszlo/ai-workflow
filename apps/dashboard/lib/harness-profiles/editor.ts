import type {
  HarnessCapabilitiesResponse,
  HarnessProfileDraftManifest,
  HarnessProfileDraftManifestV1,
  HarnessProfileDraftManifestV2,
  HarnessProfileDto,
  HarnessProfileManifest,
  HarnessProvider,
} from "@shared/contracts";
import { buildHarnessProfileDraftV2 } from "@shared/contracts";
import {
  BUILTIN_HARNESS_PROFILE_MANIFESTS,
  DEFAULT_OPENROUTER_MODEL,
} from "@shared/harness";

export type ProfileProviderOption = HarnessProvider | "openrouter";

export function isOpenRouterProfile(
  draft: Pick<HarnessProfileDraftManifest, "credentialReferences">,
): boolean {
  return draft.credentialReferences.includes("openrouter");
}

export function profileProviderOption(
  draft: Pick<HarnessProfileDraftManifest, "harness" | "credentialReferences">,
): ProfileProviderOption {
  return isOpenRouterProfile(draft) ? "openrouter" : draft.harness.provider;
}

export function draftFromManifest(
  manifest: HarnessProfileManifest,
): HarnessProfileDraftManifest {
  const {
    profileId: _profileId,
    version: _version,
    slug: _slug,
    system: _system,
    ...draft
  } = manifest;
  return structuredClone(draft);
}

export function newProfileDraft(
  provider: ProfileProviderOption,
  harnessOverride: HarnessProvider = "codex",
): HarnessProfileDraftManifestV1 {
  const effectiveHarness: HarnessProvider =
    provider === "openrouter" ? harnessOverride : provider;
  const manifest = Object.values(BUILTIN_HARNESS_PROFILE_MANIFESTS).find(
    (candidate) => candidate.harness.provider === effectiveHarness,
  );
  if (!manifest) {
    throw new Error(`Missing built-in ${effectiveHarness} compatibility profile`);
  }
  const draft = draftFromManifest(manifest);
  if (draft.schemaVersion !== 1) {
    throw new Error("Built-in compatibility profiles must use schema v1");
  }
  if (provider === "openrouter") {
    return {
      ...draft,
      displayName: "Custom OpenRouter",
      description: "",
      model: {
        id: DEFAULT_OPENROUTER_MODEL,
        options: {},
      },
      credentialReferences: ["openrouter"],
    };
  }
  return {
    ...draft,
    displayName: `Custom ${draft.displayName}`,
    description: "",
  };
}

export function withHarnessProvider(
  draft: HarnessProfileDraftManifest,
  provider: ProfileProviderOption,
  capabilities?: HarnessCapabilitiesResponse,
  harnessOverride?: HarnessProvider,
): HarnessProfileDraftManifest | null {
  const effectiveHarness: HarnessProvider =
    provider === "openrouter"
      ? (harnessOverride ?? draft.harness.provider)
      : provider;
  const baseline = newProfileDraft(provider, effectiveHarness);
  const targetDraft: HarnessProfileDraftManifestV1 = {
    ...draft,
    schemaVersion: 1,
    harness: baseline.harness,
    model: baseline.model,
    compaction: baseline.compaction,
    homeFiles: draft.homeFiles.map((file) => ({
      ...file,
      path: effectiveHarness === "codex" ? "AGENTS.md" : "CLAUDE.md",
      mode: 0o644,
    })),
    credentialReferences: baseline.credentialReferences,
  };
  if (draft.schemaVersion === 1) return targetDraft;
  if (
    !capabilities ||
    capabilities.stale ||
    capabilities.provider !== effectiveHarness ||
    capabilities.cliVersion !== baseline.harness.cliVersion
  ) {
    return null;
  }
  return buildHarnessProfileDraftV2(targetDraft, capabilities);
}

export function upgradeProfileDraft(
  draft: HarnessProfileDraftManifestV1,
  capabilities: HarnessCapabilitiesResponse,
): HarnessProfileDraftManifestV2 | null {
  // Upgraded only onto a model the catalog advertises; the builder answers
  // null for any other, and the draft stays readable as it was.
  return buildHarnessProfileDraftV2(draft, capabilities);
}

export function withHarnessModel(
  draft: HarnessProfileDraftManifest,
  capabilities: HarnessCapabilitiesResponse,
  modelId: string,
): HarnessProfileDraftManifestV2 | null {
  const model = capabilities.models.find((candidate) => candidate.id === modelId);
  if (
    capabilities.stale ||
    capabilities.provider !== draft.harness.provider ||
    capabilities.cliVersion !== draft.harness.cliVersion ||
    !model
  ) {
    return null;
  }
  const effort =
    model.defaultReasoningEffort ?? model.reasoningEfforts[0]?.id;
  const serviceTier =
    model.defaultServiceTier ?? model.serviceTiers[0]?.id;
  if (!effort || !serviceTier) return null;

  return {
    ...draft,
    schemaVersion: 2,
    model: {
      id: model.id,
      reasoning: {
        selection: model.defaultReasoningEffort
          ? "model_default"
          : effort,
        effectiveEffort: effort,
      },
      serviceTier,
      ...(model.defaultVerbosity
        ? { verbosity: model.defaultVerbosity }
        : {}),
      capability: structuredClone(model),
      catalogHash: capabilities.catalogHash,
    },
    compaction: { mode: "model_default" },
  };
}

/**
 * The models a profile may pick: the capability catalog's own, in its order,
 * each once. The catalog is what the worker accepts on publish, so it is the
 * only list; the Claude CLI reports aliases (`default`, `opus[1m]`, `sonnet`,
 * `haiku`), and a filter against API ids offered none of them.
 */
export function selectableHarnessModels(
  capabilities: HarnessCapabilitiesResponse,
): HarnessCapabilitiesResponse["models"] {
  const seen = new Set<string>();
  return capabilities.models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

/**
 * What the Model field says about the profile's model, and the warning under
 * it. A model the catalog lists reads as its name. One it does not list is
 * either the built-in profile's (an API id the CLI accepts, which runs use
 * every day, so no warning) or a custom profile's from an older catalog, which
 * has to be replaced before the next publish.
 */
export function modelSelectionLabel(
  modelId: string,
  catalog: HarnessCapabilitiesResponse["models"],
  builtIn: boolean,
): { readonly label: string; readonly warning: string | null } {
  const listed = catalog.find((model) => model.id === modelId);
  if (listed) return { label: listed.name, warning: null };
  if (builtIn) return { label: `${modelId} · set by the built-in profile`, warning: null };
  return {
    label: `${modelId} · not in the current catalog`,
    warning: "Historical selection; choose a current model before publishing.",
  };
}

export function isProfileSlug(value: string): boolean {
  return (
    value.length <= 64 &&
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value)
  );
}

export function canEditProfile(
  profile: HarnessProfileDto,
  canManageProfile: boolean,
): boolean {
  return (
    canManageProfile &&
    !profile.system &&
    !profile.readOnly &&
    profile.archivedAt === null
  );
}

export function upsertProfile(
  profiles: HarnessProfileDto[],
  profile: HarnessProfileDto,
): HarnessProfileDto[] {
  return profiles.some((candidate) => candidate.id === profile.id)
    ? profiles.map((candidate) =>
        candidate.id === profile.id ? profile : candidate,
      )
    : [profile, ...profiles];
}
