---
name: index
description: "Use this Sales index first for explicit Sales mentions and clear seller workflows: prospecting, lead qualification, account research, monitoring or prioritization, meeting prep, call follow-up, outreach research, deal strategy, pipeline or forecast review, CRM-backed context or data enrichment, internal source finding or sales support, customer quotes or evidence, business cases, competitive briefs, rep coaching, sales company research, and company or contact enrichment. For implicit use require clear seller, prospect, account, opportunity, pipeline, forecast, CRM, or customer-facing sales intent."
---

# Sales Index Skill


## Context-Gathering Intake

Whenever this skill asks for context, strongly prefer using the `answers-ask-user-input` skill and the `ask_user_input` tool over other tools such as `request_user_input`; otherwise ask directly in the conversation.

After this index is invoked, treat it as a router rather than the final workflow. If any focused skill plausibly owns the request, select and follow the best match; do not answer through the index alone. Handle broad orientation requests directly through the canonical orientation response, and handle other plugin-level questions directly only when no focused skill owns them.

MANDATORY: Read the frontmatter description for ALL skills in this plugin, and based on that, decide which to trigger and read more deeply.

## Plugin Purpose

Sales provides evidence-grounded workflows for customer-facing preparation, follow-up, account and prospect research, pipeline decisions, deal strategy, customer evidence, internal navigation, business cases, coaching, and CRM-backed context.

## Broad Orientation

For broad orientation requests such as “what can you do?”, “help me get started”, “what should I try?”, or “how do I use Sales?”, do not choose a focused workflow. Load `references/orientation-response.md` and return its user-facing content as written. Treat that file as the canonical, updatable output surface for this branch. Offer the full skill catalog only when the user asks for it.

## Cross-Skill Best Practices

These should be used as configuration and rules to be followed by default across all skills.

### Audience and Language

- Users of this plugin are not expected to know code or internal implementation details
- Use simple, high-level language that communicates the key information needed about the work, not about what's happening under the hood. Don't narrate mechanical processes during the rollout.
- These users are experts in their domain, and want information about why you made certain logical decisions, want to provide input to improve outputs and apply their taste, and want to learn enough about what's happening so they can reason about and trust the outputs.
- These users want to be treated as intelligent collaborators who are in the driver seat for key decisions, you should work with them to ensure you're on the right track and giving them what they need.

### Dependencies

Skills refer to source categories with placeholders such as `~~CRM`, `~~Calendar`, or `~~Meeting Transcripts`.

Resolve each category from the host harness's actually available tools, connectors, uploaded files, pasted context, and current conversation. Do not assume a bundled connector manifest exists or that a named provider is installed.

#### Category Resolution

1. Identify the categories used by the selected workflow in its dependency categories section.
2. Treat every listed category as useful but non-blocking by default. A category blocks the first output only when the focused skill explicitly marks it `[Blocking]`.
3. A `[Blocking]` category is satisfied when either a suitable installed app is available or the user has already provided equivalent context. Do not request installation merely because the connector is absent when the needed information is already grounded in the conversation, pasted notes, links, or files.
4. Check whether an installed app matches each category you plan to use. The initially surfaced app list is only a hint and is NEVER sufficient evidence that a provider is absent. Before making any negative availability claim, saying a connector is not installed, naming an installation gap, or offering an install, you MUST search the live/lazy tool registry for the provider name and credible category-equivalent providers. A live tool match is sufficient to treat that provider as installed and available for dependency resolution, even when it was omitted from the surfaced app list. If the provider is found but its tools are missing on the first discovery pass, recheck discovery once. Only after both checks fail may you describe it as unavailable. Do not infer readiness or absence from metadata, recommended-install lists, manifests, vendored skills, or the initially surfaced app list alone.
5. Note that only one suitable app is needed to satisfy a category. Use additional apps when they materially improve coverage, freshness, confidence, or actionability.

#### Missing Source Resolution

- Apply this sequence whenever a material category selected for the current workflow has no verified usable source, whether the category is blocking or non-blocking:
  1. If equivalent user-provided context already exists, proceed without requesting installation.
  2. Before declaring the category unavailable, search the host's live or lazy tool registry for suitable category-equivalent providers. If the host exposes an install/connect surface, use it only with real provider identifiers returned by that surface; never guess identifiers.
  3. For a `[Blocking]` category, briefly explain why the source is needed, what evidence it would add, and that the first output cannot proceed without it. If a suitable provider is available, offer it through the install/connect UI before asking for fallback context. Prefer a user-named provider; otherwise recommend the best available match. When multiple options are materially different and no preference is known, offer a bounded choice.
  4. For a `[Blocking]` category with no suitable provider, or when the install/connect attempt is declined or fails, offer the user a choice: check the installed plugin's page in the Plugins tab for other provider options, or provide the smallest useful uploaded or pasted context needed to proceed. Pause the first output until the source or equivalent context is available; otherwise return a clearly blocked result.
  5. For a non-blocking category, do not open the install/connect UI, ask for fallback context, or pause before the first useful output. Continue with a safe partial output, state the practical limitation, and only after presenting that result offer the suitable provider or fallback context as an optional improvement.
- Prefer canonical plugins over connectors only when choosing among installation options. Do not request a second app solely because it is more canonical when an installed app already satisfies the category.

#### Source authority

- Strongly prefer `~~CRM` for customer truth, account ownership, opportunity status, contacts, and pipeline context.
- If CRM is unavailable, clearly state that customer information came from less authoritative sources.
- Use web search only as fallback context or additional enrichment.
- Do not use browser automation as a fallback for unavailable connectors.
- When the Salesforce or Hubspot Connector is the CRM, use the appropriate vendored skills in this plugin.
- When connected ZoomInfo is selected for Sales Intelligence work, load the vendored ZoomInfo skill before provider-specific search, enrichment, or recovery.
- When connected Apollo is selected for Sales Intelligence work, load the vendored Apollo skill.

### User Input Modalities

You have multiple available methods of getting input from the user:
- User input elicitation: You can ask the user to answer questions with a generic form, usually via the `ask_user_input()` function. Prefer this whenever there are questions with strong suggested defaults, where it would be faster to accept via a click than typing a response. Bias strongly to preferring this tool over a text-based question.
- Plugin install elicitation: You can ask the user to install plugins, connectors or apps with a special UI, usually via the `request_plugin_install()` function.
- Text: You can always ask the user questions via markdown in a chat context.

Example
```
*thinking*
{need CRM account truth and CRM is marked [Blocking]; Salesforce is available to install}
{tell user: "Salesforce is needed to establish the account set and ownership, so I cannot produce the first ranking without it or equivalent account context."}
{request_plugin_install(['Salesforce'])}

{Email is useful but non-blocking; Gmail is available to install}
{continue to the first useful output, state the email limitation, then offer Gmail as an optional next step}

{need clarification between three valid options}
{ask_user_input(['Option 1', 'Option 2', 'Option 3'])}

{final answer to the user}
```

### Workflow Steps

Your goal is to provide the user with the most value with the least amount of mental load and burden. You should default to making assumptions to produce user value more quickly, but if there are questions that materially change the output, and help de-risk the downstream value of longer workflows, you should ask. This is also an opportunity to help the user discover additional value and next steps they might not have been aware of. Avoid dead-ends and always provide a short offer for a helpful next step given their intent.

The offer for a next step should always append to any output formatting specified in a particular skill.

Here is the default flow you should follow for each skill:

#### 1. Resolve Dependencies and Clarify
- Review the dependency categories listed in the skill. Treat unlabeled categories as useful but non-blocking. Resolve missing `[Blocking]` categories before the first output; defer non-blocking install offers and fallback requests until after the first useful output.
- Do a quick context gathering pass to better understand the problem and constraints
- If needed, ask the user to resolve any high-impact, high-uncertainty questions. Use the ask_user_input tool with a batch of questions. This must happen within the first 20s of the rollout. After these questions you should be clear to execute on the First Output.

#### 2. Gather Context
- After assessing user-provided context, start with an available category that owns the core source of truth, then attempt only additional available categories that can materially improve the selected artifact, confidence, or next action.
- In an intermediate update message to the user, highlight which material dependencies are available that you'll try to use.
- Aim for a balance of completeness and speed: broaden when the first pass is empty, thin, conflicting, or a decision depends on the missing evidence; stop once the artifact is grounded.
- If a material dependency category isn't available, or a material search returned no useful context, communicate the practical limitation to the user.

#### 3. First Output
- After sufficient context has been gathered, provide the user with an output
- Default to providing output in chat, but if the skill or user instruction prefers another output like html or a document, use that instead.
- Remember to identify the likely underlying user goal behind the request and try to address that, as well as satisfying their object-level request.
- Below are two common elements that should be used by default in all outputs.

##### Limitations and Improvements

The first output is "best effort" and tries to give the most useful response relative to the connectors and context available. In this output, you should give the user context on the strength of your answer and instruct how it can be improved through installing new connectors.

Details:
- Start with 1–2 sentences describing the answer’s strengths, grounding, and known gaps.
- For available connectors with no relevant evidence, mention what was checked and what was or wasn't found.
- For unresolved non-blocking categories, state the practical limitation and name a suitable provider as an optional improvement when one is available. Offer its install/connect UI only after the first output, normally in Next Steps.
- For unresolved blocking categories, report whether a provider was offered, no suitable provider was found, or the install/connect attempt failed or was declined. Mention the plugin-page, pasted/uploaded-context, or IT fallback only after no suitable installable provider was found or the install/connect attempt failed or was declined.

**Output Format**
```
## Confidence and Gaps

This brief provides a solid orientation from the invite and shared notes, but it does not yet capture prior-call decisions, unresolved commitments, or authoritative account and opportunity context.

Potentially helpful context:

1. **[Category]:** [Provider] is available to install and could add [specific missing evidence].
2. **[Category]:** No suitable installable provider was found, so [plugin-page, pasted/uploaded-context, or IT fallback] is the next path for [specific missing evidence].
```

##### 4. Next Steps
- *Always* offer one clear next step to help the user get more value and discover useful adjacent functionality.
- When the focused skill provides `Next Step Options`, choose the single most relevant transition from that list. Do not present the whole menu, offer an action already completed, or suggest an action that conflicts with the workflow's ownership or safety rules.
- When the focused skill does not provide options, use your judgment. Some common fallback options:
  - Install new connectors if they could materially improve output quality
  - Iterate on and improve the output
  - Create a document, presentation, spreadsheet, or html report
  - Draft response(s) in Slack or Email to help with next steps
  - Take another action in a relevant tool
  - Set up an automation to follow up or refresh the output in the future

**Output Format**

```
{other message outputs}

Anything you'd change, or would you like me to [single most relevant next step]?
```
