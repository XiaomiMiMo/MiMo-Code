import type * as ModelsDev from "./models"

/**
 * Input-modality inference for models the user declares themselves.
 *
 * A model configured under `provider.<id>.models.<id>` may say nothing about
 * `modalities`. Something still has to answer "can this model read an image?",
 * because `provider/transform.ts` uses that answer to decide whether to forward
 * an image part or replace it with an error sentence addressed to the model.
 *
 * The answer is resolved in strict precedence order:
 *
 *  1. DECLARED     — the user wrote `modalities` in config. Always authoritative.
 *  2. BUILTIN      — this repo ships the answer for one of its own aliases that
 *                    no catalog documents. See `BUILTIN_INPUT`.
 *  3. PROVIDER-ENTRY — the same-named models.dev provider already lists this
 *                    model id, so its metadata is inherited.
 *  4. DIRECTORY    — the model id alone is looked up across the whole models.dev
 *                    directory and the FIRST-PARTY entry is used. This is the
 *                    tier that a user-invented provider id needs: `mimo-v2.5`
 *                    served through a provider called `mimo` matches nothing in
 *                    tier 3, but the model itself is documented under `xiaomi`.
 *  5. ASSUMED      — nothing is known. This is UNKNOWN, and unknown is not the
 *                    same as unsupported (see `assumedInput` for why unknown
 *                    resolves permissively).
 *
 * Tiers 4 and 5 are the new ones. Before them, an unmatched model fell straight
 * to a hardcoded `false` for every non-text modality, which turned "we never
 * looked this up" into the much stronger claim "we know it cannot do this".
 *
 * Only tiers 1 and 2 are STATED by someone who knows (see `isStated`); the rest
 * are worked out from metadata that may not describe this deployment.
 */

export type InputModality = "text" | "audio" | "image" | "video" | "pdf"

export type ModalityProvenance = "declared" | "builtin" | "provider-entry" | "directory" | "assumed"

export type ModalityMap = Record<InputModality, boolean>

export interface InputCapabilities {
  readonly input: ModalityMap
  readonly inferred?: { readonly input?: ModalityProvenance }
}

/**
 * Input modalities this repo itself ships the answer for, keyed `providerID/modelID`.
 *
 * `mimo-auto` is a free-tier routing ALIAS rather than a model: no vendor
 * publishes it, so no catalog tier can ever match it, and it dispatches to a
 * vision-capable model. Its image support is therefore not something to infer —
 * it is a fact this repo owns, and stating it here puts it at the same standing
 * as a user's own `modalities` declaration.
 *
 * It has to enter the pipeline HERE, as part of the verdict, and not be patched
 * onto the finished model afterwards. Assigning `capabilities.input.image = true`
 * after the fact leaves the verdict's own provenance saying `assumed`, and every
 * consumer that asks for EVIDENCE of image support (`Provider.hasEvidencedImageInput`)
 * then reads the alias as unknown and passes over it — which is how the only
 * vision channel a free-tier user has got excluded from automatic vision-model
 * selection while its `input.image` said `true` the whole time.
 *
 * Entries are COMPLETE input maps: an unlisted modality is `false`, not unknown.
 * The permissive `assumed` tier exists for models nobody looked up, which is the
 * opposite of these.
 */
const BUILTIN_INPUT: Record<string, readonly InputModality[]> = {
  "mimo/mimo-auto": ["text", "image"],
}

/**
 * Whether a provenance means the answer was STATED by someone who knows — the
 * user's own config, or this repo's own catalog of its aliases — as opposed to
 * worked out from third-party metadata or defaulted.
 *
 * Callers that warn "this verdict may be wrong" or log it as inferred should ask
 * this rather than compare against `"declared"`, so that a stated fact is not
 * reported to the model as a guess.
 */
export function isStated(provenance: ModalityProvenance): boolean {
  return provenance === "declared" || provenance === "builtin"
}

export function acceptsInput(capabilities: InputCapabilities, modality: InputModality): boolean {
  return capabilities.input[modality]
}

export function hasEvidencedInput(capabilities: InputCapabilities, modality: InputModality): boolean {
  return acceptsInput(capabilities, modality) && (modality === "text" || capabilities.inferred?.input !== "assumed")
}

export interface InputModalityVerdict {
  readonly modalities: ModalityMap
  readonly provenance: ModalityProvenance
  /** models.dev ref the verdict came from. Only set for `"directory"`. */
  readonly source?: string
}

export function mapOf(list: readonly string[] | undefined, fallback: boolean): ModalityMap {
  const has = (modality: InputModality) => (list ? list.includes(modality) : fallback)
  return {
    text: has("text"),
    audio: has("audio"),
    image: has("image"),
    video: has("video"),
    pdf: has("pdf"),
  }
}

/**
 * The verdict for a model nothing is known about: every input modality is
 * permitted.
 *
 * This is a deliberate bias, and the reason is that the two ways of being wrong
 * do not cost the same. Guess "supported" wrongly and the request goes out and
 * the provider answers with an explicit 4xx naming the media it rejected —
 * loud, attributable, and fixable by declaring `modalities` in config. Guess
 * "unsupported" wrongly and the image is replaced, before the request is built,
 * by a sentence only the model can see: the model then truthfully reports that
 * it received no image, the image is sitting in the session record the whole
 * time, and there is nothing anywhere that says the engine chose to drop it.
 *
 * The scope of this bias is narrow on purpose. It applies only to models the
 * user declared in config AND that no models.dev entry covers; catalog-sourced
 * models keep answering strictly from their metadata.
 */
export function assumedInput(): ModalityMap {
  return mapOf(undefined, true)
}

/**
 * Bare-model-id index over the models.dev directory.
 *
 * Built once per provider-state init and then queried per configured model, so
 * the full directory walk happens a single time rather than per lookup.
 */
export interface DirectoryIndex {
  /**
   * The first-party models.dev entry for a bare model id, or `undefined` when
   * there is no single unambiguous one.
   */
  official(modelID: string): { readonly ref: string; readonly model: ModelsDev.Model } | undefined
}

/**
 * models.dev publishes no "first party" flag, so first-partyness is derived from
 * the shape of the directory itself.
 *
 * Aggregators list a resold model under the VENDOR NAMESPACE they bought it
 * from — `xiaomi/mimo-v2.5`, `openai/gpt-5`, `anthropic/claude-sonnet-4-5`. The
 * vendor's own provider entry, in contrast, lists the model under its bare id.
 * So the namespace that aggregators agree on names the vendor provider, and
 * intersecting those namespaces with the providers that carry the bare id yields
 * the vendor's own entry.
 *
 * Requiring EXACTLY ONE survivor is what keeps this from becoming a guess. No
 * union of the aggregators' claims, no majority vote: either the directory
 * points at one first-party entry or the lookup declines to answer and the
 * caller falls through to `assumedInput`. A namespace that no provider serves
 * (`xiaomimimo/…`, `gemini/…`) and an aggregator that namespaces under its own
 * id both drop out of the intersection for free.
 */
export function directoryIndex(database: Record<string, ModelsDev.Provider>): DirectoryIndex {
  /** bare model id -> providers whose own entry uses that exact id */
  const holders = new Map<string, Set<string>>()
  /** bare model id -> vendor namespaces some provider prefixes it with */
  const namespaces = new Map<string, Set<string>>()

  const add = (index: Map<string, Set<string>>, key: string, value: string) => {
    const existing = index.get(key)
    if (existing) {
      existing.add(value)
      return
    }
    index.set(key, new Set([value]))
  }

  Object.entries(database)
    .flatMap(([providerID, provider]) => Object.keys(provider.models ?? {}).map((modelID) => ({ providerID, modelID })))
    .forEach(({ providerID, modelID }) => {
      const slash = modelID.indexOf("/")
      if (slash === -1) {
        add(holders, modelID, providerID)
        return
      }
      add(namespaces, modelID.slice(slash + 1), modelID.slice(0, slash))
    })

  const resolved = new Map<string, { ref: string; model: ModelsDev.Model } | undefined>()

  function lookup(providerID: string, modelID: string) {
    const model = database[providerID]?.models?.[modelID]
    if (!model) return undefined
    return { ref: `${providerID}/${modelID}`, model }
  }

  return {
    official(modelID) {
      if (resolved.has(modelID)) return resolved.get(modelID)
      const answer = (() => {
        // An id the user already wrote namespaced names its own vendor provider.
        const slash = modelID.indexOf("/")
        if (slash !== -1) return lookup(modelID.slice(0, slash), modelID.slice(slash + 1))
        const owners = holders.get(modelID)
        if (!owners) return undefined
        const candidates = [...(namespaces.get(modelID) ?? [])].filter((ns) => owners.has(ns))
        if (candidates.length !== 1) return undefined
        return lookup(candidates[0], modelID)
      })()
      resolved.set(modelID, answer)
      return answer
    },
  }
}

export interface ResolveInput {
  /** `modalities.input` as written in config, when the user wrote it. */
  readonly declared?: readonly string[]
  /** Tier 3: input modalities of the same-named provider's existing entry. */
  readonly inherited?: ModalityMap
  /** Tier 4 lookup key — the id actually sent upstream. */
  readonly apiID: string
  readonly directory: DirectoryIndex
  /**
   * Tier 2 lookup key — the CONFIG-side identity, because that is what the
   * engine's own aliases are named by. `apiID` is what goes upstream and a user
   * may point any local id at it.
   */
  readonly providerID: string
  readonly modelID: string
}

export function resolveInput(input: ResolveInput): InputModalityVerdict {
  if (input.declared !== undefined) return { modalities: mapOf(input.declared, false), provenance: "declared" }
  const builtin = BUILTIN_INPUT[input.providerID + "/" + input.modelID]
  if (builtin) return { modalities: mapOf(builtin, false), provenance: "builtin" }
  if (input.inherited) {
    return {
      modalities: { ...input.inherited },
      provenance: "provider-entry",
      source: input.providerID + "/" + input.modelID,
    }
  }
  const official = input.directory.official(input.apiID)
  if (official?.model.modalities?.input) {
    return {
      modalities: mapOf(official.model.modalities.input, false),
      provenance: "directory",
      source: official.ref,
    }
  }
  return { modalities: assumedInput(), provenance: "assumed" }
}

/**
 * Output modalities get the catalog tiers but NOT the permissive `assumed` one,
 * and no `builtin` tier either.
 *
 * Nothing decides whether to send content based on output modalities, so an
 * unknown carries no silent-drop risk to correct for; claiming a model emits
 * video would be an invention with no upside. Unknown therefore keeps the
 * long-standing text-only shape — which is already what the engine's own
 * aliases emit, so there is nothing for a builtin entry to state.
 */
export function resolveOutput(input: ResolveInput): InputModalityVerdict {
  if (input.declared !== undefined) return { modalities: mapOf(input.declared, false), provenance: "declared" }
  if (input.inherited) {
    return {
      modalities: { ...input.inherited },
      provenance: "provider-entry",
      source: input.providerID + "/" + input.modelID,
    }
  }
  const official = input.directory.official(input.apiID)
  if (official?.model.modalities?.output) {
    return {
      modalities: mapOf(official.model.modalities.output, false),
      provenance: "directory",
      source: official.ref,
    }
  }
  return { modalities: { ...mapOf(undefined, false), text: true }, provenance: "assumed" }
}

export * as ModalityInference from "./modality-inference"
