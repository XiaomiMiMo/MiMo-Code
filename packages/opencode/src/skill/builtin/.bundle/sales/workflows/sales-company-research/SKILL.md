---
name: sales-company-research
description: Research companies, partners, and referral channels to shape draft outreach approaches, messages, or partner motions; exclude descriptive company profiling, list enrichment, and internal source finding.
---

# Sales Company Research

Turn external company or partner research into a grounded, draft-only outreach approach. This skill owns research-to-outreach work: company or partner context, fit hypotheses, likely motion, and message drafts. It does not own data-first prospect-list enrichment, internal source-of-truth lookup, sending messages, or CRM writes.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to `plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices`.

## Key Dependency Categories

- ~~Sales Intelligence for company, contact, partner, firmographic, similarity, and external-signal context
- ~~CRM for existing account, ownership, lifecycle, opportunity, and prior-engagement truth
- ~~Knowledge & Files for approved positioning, proof points, partner criteria, and outreach guardrails
- Public research for company-controlled facts, reputation, partner programs, and current market context

Use the user-provided company, domain, partner type, product, or offer as the anchor. If a material anchor is missing, ask only for the smallest input that changes the research path; otherwise proceed with clearly labeled assumptions.

## Workflow

1. Resolve the research target and commercial purpose: company fit, partner fit, referral landscape, reputation, or outreach approach.
2. Gather the narrowest useful evidence from authoritative sources first. Keep sourced company or partner facts distinct from inferred fit, likely buyer need, and recommended motion.
3. Explain why the target or partner type is promising, uncertain, or a poor fit. Name material evidence gaps instead of filling them with generic claims.
4. Draft only the outreach artifact the user asked for, such as an approach, short email, message, connection request, or partner script. Do not send, post, create a draft in an external system, or update CRM.

## Routing Boundaries

- Use `enrich-company-and-contact-data` when the primary output is a list, missing fields, contact discovery, segmentation, qualification, or firmographic comparison.
- Use `find-key-internal-sources` when the primary question is which internal owner, document, channel, approver, or source of truth to use.
- Use `plan-deal-strategy` when the primary job is advancing a defined sale, negotiation, renewal, buying process, or initial sales motion rather than researching a target to shape outreach.

### Next Step Options

After the first output, offer the most relevant follow-up from the options below. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Improve the fit hypothesis, audience, angle, or sequencing using the user's guidance.
- Draft an alternate outreach version for a different stakeholder or channel.
- Hand the target to meeting prep or deal strategy when an active conversation or motion exists.
- Create a concise research brief or internal account-team note after the content is reviewed.
- Close the smallest material evidence gap that would change the outreach approach.

Next steps to avoid:
- Sending outreach, creating external drafts, or writing CRM without a separate explicit request.

## Output

Return a compact research-to-outreach package:

```md
# Sales Research: [Target or Partner Segment]

## Sourced Context
- [Fact + source]

## Fit And Motion
- **Fit hypothesis:** [Inference and confidence]
- **Likely need or partner angle:** [Inference and evidence basis]
- **Risks / gaps:** [What remains unknown]

## Recommended Outreach Approach
- [Audience, angle, sequencing, and safe next step]

## Draft Outreach
> [Draft-only message]

No message was sent and no CRM record was changed.

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

## Rules

- Cite material sourced claims with useful links when available.
- Label inference clearly; do not invent company facts, partner terms, contacts, reputation claims, or fit evidence.
- Keep outreach draft-only. Never send, post, create external drafts, or write CRM in this workflow.
