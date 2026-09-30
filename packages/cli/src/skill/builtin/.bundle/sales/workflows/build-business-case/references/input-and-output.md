# Input And Output Rules

Use this reference to normalize incomplete inputs and choose the right build-business-case output shape. Keep workflow sequencing in `workflow.md` and evidence/assumption labeling in `value-model-and-evidence.md`.

## Standard inputs

This skill must work with incomplete and uneven inputs.

Typical inputs may include:

- account notes
- discovery call transcript
- customer metrics
- ~~CRM summary
- ~~Meeting Transcripts transcript
- product usage data
- customer website
- 10-K, annual report, or investor presentation
- internal account strategy materials
- prior internal business case materials

Useful selectors and hints may include:

- `company_name`
- `industry`
- `buyer_role`
- `workflow_focus`
- `solution_scope`
- `customer_metrics`
- `source_materials`
- `decision_context`
- `strategic_priorities`
- `known_constraints`
- `current_tools`
- `public_research`
- `output_mode`

Default behavior:

- default `public_research` to `true` for named public companies when it can sharpen why-now context
- default `output_mode` to `default_package`
- if a named public company is present, run a focused public research pass by default unless the account-native anchor already answers the material why-now question
- if the user explicitly disables public research, skip it
- if no named company is present, do not force public research
- if public sources are unavailable, thin, or low-signal, continue with internal evidence and label the gap
- if `solution_scope` is missing, keep the case solution-aware but avoid overcommitting to one product until the workflow logic supports it
- if inputs are sparse, proceed with a clearly labeled directional or public-context hypothesis rather than blocking

If inputs are incomplete, the skill must:

- say what is known
- say what is missing
- label assumptions clearly
- suggest follow-up questions

Input handling rules:

- Do not fail just because some inputs are missing.
- Stronger evidence outranks weaker evidence.
- Public materials can support the narrative, but must not silently replace customer truth.
- Use public research to sharpen strategic priorities, current pressure, executive wording, market/operating context, and "why now" framing.
- Do not use public research to invent baseline workflow metrics, internal tooling certainty, economic buyer certainty, or customer-confirmed ROI.
- If customer, workflow, and decision context are all too weak to form a stable first-pass hypothesis, ask only the minimum clarifying question needed.

## Internal account-scoped evidence order

- Attempt ~~CRM account resolution, account history, opportunity context, and activity review first when the request is tied to a named account.
- Use ~~Knowledge & Files for account plans, discovery notes, prior business cases, and narrative account context.
- Use ~~Meeting Transcripts next for transcript-backed workflow, stakeholder, and blocker evidence.
- Use user-provided enrichment exports or public sources only as a fallback when ~~CRM and ~~Meeting Transcripts evidence still leave a critical evidence gap, especially for quantification inputs.
- Keep `Known`, `Inferred`, `Assumed`, and `Missing` labels visible whenever evidence is mixed.

## Standard outputs

By default, the skill should be able to produce the following outputs.

### `Executive summary`

Must include:

- what the customer is trying to achieve
- why it matters now
- the most relevant workflows and use cases
- the likely value story
- why the seller solution is relevant

If public-company context materially sharpens the case, include it here in the "why now" framing. Keep it concise enough for an executive to understand the case in under a minute.

### `Business case summary`

Must include:

- executive summary
- strategic initiatives
- key challenges
- priority workflows
- priority use cases
- workflows and use cases mapped to strategic priorities
- value hypothesis by use case
- value metrics
- assumptions
- confidence levels
- proof points
- open questions

When public research is available, explicitly distinguish public strategic context from account-native proof. This is the main decision-useful package when the user asks for a business case or when the default package is appropriate.

### `ROI or value model structure`

Must include:

- workflow
- use case
- value bucket
- required metrics
- formula logic
- known inputs
- assumptions
- low, base, and high scenarios
- caveats

If inputs are too weak for quantified scenarios, keep the structure and state exactly what data would be required to move from structural case to quantified case.

### `Customer-ready narrative`

Must be tailored to:

- customer industry
- likely buyer
- business priorities
- current market or operating context

This narrative should sound consultative and outcome-oriented, not like a product datasheet.

### `Differentiators section`

Must explain why the seller solution is a strong fit for the customer's workflows and use cases.

Keep differentiators tied to the workflow, buyer need, and expected business effect. Do not use generic `best-in-class` language with no customer relevance. When relevant, tie differentiators to both account-native workflow evidence and public strategic context.

### `Follow-up questions`

Must include the most important questions needed to strengthen the business case.

Prefer the smallest useful set of questions. Ask for the inputs that materially improve the case.
