# Skill Structure Patterns

Proven approaches observed across real skills. Pick the framing first:

- **Problem-first**: user describes an outcome ("set up a project workspace") → the skill orchestrates the right tools in the right sequence.
- **Tool-first**: user has tool access (an MCP server, a CLI) → the skill teaches optimal workflows and best practices for it.

Most skills lean one direction; knowing which fits helps pick a pattern below.

## Pattern 1: Sequential workflow orchestration

Use when users need multi-step processes in a specific order.

```markdown
## Workflow: Onboard New Customer

### Step 1: Create Account
Call tool: `create_customer` — parameters: name, email, company

### Step 2: Setup Payment
Call tool: `setup_payment_method`. Wait for: payment method verification.

### Step 3: Create Subscription
Call tool: `create_subscription` — parameters: plan_id, customer_id (from Step 1)

### Step 4: Send Welcome Email
Call tool: `send_email` — template: welcome_email_template
```

Key techniques: explicit step ordering, stated dependencies between steps, validation at each stage, rollback instructions for failures.

## Pattern 2: Multi-MCP coordination

Use when workflows span multiple services.

```markdown
## Phase 1: Design Export (Figma MCP)
Export assets, generate specs, create asset manifest.

## Phase 2: Asset Storage (Drive MCP)
Create project folder, upload assets, generate shareable links.

## Phase 3: Task Creation (Linear MCP)
Create dev tasks, attach asset links, assign to engineering.

## Phase 4: Notification (Slack MCP)
Post handoff summary with asset links and task references.
```

Key techniques: clear phase separation, explicit data passing between services, validation before advancing phases, centralized error handling.

## Pattern 3: Iterative refinement

Use when output quality improves with iteration.

```markdown
## Initial Draft
Fetch data → generate first draft → save to temporary file.

## Quality Check
Run `scripts/check_report.py`; identify missing sections, formatting
inconsistencies, data validation errors.

## Refinement Loop
Address each issue → regenerate affected sections → re-validate →
repeat until the quality threshold is met.

## Finalization
Apply final formatting, generate summary, save final version.
```

Key techniques: explicit quality criteria, validation scripts, a defined stopping condition (know when to stop iterating).

## Pattern 4: Context-aware tool selection

Use when the same outcome needs different tools depending on context.

```markdown
## Decision Tree
1. Check file type and size
2. Choose storage:
   - Large files (>10MB): cloud storage MCP
   - Collaborative docs: Notion/Docs MCP
   - Code files: GitHub MCP
   - Temporary files: local storage
3. Execute, apply service-specific metadata, generate access link
4. Tell the user why that choice was made
```

Key techniques: clear decision criteria, fallback options, transparency about choices.

## Pattern 5: Domain-specific intelligence

Use when the skill adds specialized knowledge beyond tool access.

```markdown
## Before Processing (Compliance Check)
Fetch transaction details → apply compliance rules (sanctions lists,
jurisdiction allowances, risk level) → document the decision.

## Processing
IF compliance passed: process the payment with fraud checks.
ELSE: flag for review and create a compliance case.

## Audit Trail
Log all checks, record decisions, generate audit report.
```

Key techniques: domain expertise embedded in the logic, compliance gates before action, comprehensive documentation.

## Composability and portability

- The agent can load multiple skills at once — never assume yours is the only capability available; delegate to other skills where they fit (e.g. "use a PDF-processing skill for the downloaded file").
- Skills should work identically across surfaces (chat, CLI, API). Note environment requirements in the `compatibility` frontmatter field rather than assuming them.
