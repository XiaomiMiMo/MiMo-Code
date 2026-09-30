---
name: prepare-for-meeting
description: "Use when the user wants to prepare for one or more upcoming meetings with customers, prospects, partners, accounts, or important stakeholders; requests daily or date-based meeting preparation; asks to organize a same-day customer call queue; asks for the most important qualifying meeting of the day; or identifies meetings only by company, attendee, topic, or date. Produce an individual meeting brief or a chronological multi-meeting agenda as appropriate."
---

# Prepare for Meeting


## Context-Gathering Intake

Whenever this skill asks for context, strongly prefer using the `answers-ask-user-input` skill and the `ask_user_input` tool over other tools such as `request_user_input`; otherwise ask directly in the conversation.

Prepare a sales person for a critical customer or internal meeting, with all relevant context needed to help them reach the stated or assumed goal of the meeting.

## Common Skill Instructions

MANDATORY: If not already in context, read and adhere closely to `plugins/sales/skills/index/SKILL.md## Cross-Skill Best Practices`.

## Meeting Ranking

Use this priority order for selecting meetings if the specific meeting is ambiguous.

1. Explicit user request, named meeting, named account, named topic, or stated preference
2. Meetings the user owns, leads, presents in, or is expected to drive
3. Customer, prospect, partner, renewal, opportunity, or strategic account meetings
4. Large or cross-stakeholder internal meetings with decisions, dependencies, launches, escalations, or leadership visibility
5. Meetings with buyer, executive, technical decision-maker, or senior stakeholder attendance
6. Meetings with explicit decisions, blockers, risks, commitments, or time-sensitive next steps
7. Meetings where prep is likely to materially improve the user’s next action

Routine internal syncs, 1:1s, recruiting meetings, and performance discussions are lower priority, but may still qualify when explicitly requested, user-owned, or clearly high-stakes.

## Key Dependency Categories

These are particularly important for this workflow; use your best judgment to potentially include other data sources to improve quality.

- [Blocking] ~~Calendar for meeting identity, invite context, agenda, and attendees. It blocks only when the meeting must be discovered or selected.
- ~~Meeting Transcripts for prior decisions, objections, commitments, and continuity
- ~~Email for prior meeting notes, recent questions, and customer-facing context
- ~~Internal Messaging for internal strategy, blockers, owners, and dependencies
- ~~Knowledge & Files for prior meeting notes, strategy docs, and assets
- ~~CRM for account, opportunity, renewal, and contact truth
- ~~Sales Intelligence only when it materially improves preparation

Avoid unsupported claims. If context is missing, stale, or conflicting, state the limitation.

## Workflow Guidance

These meeting-specific steps modify and override the default workflow in the index skill.

- 1. Resolve Dependencies and Clarify
    - If the mode isn't clear, ask the user via `ask_user_input()`. For a bare invocation such as “run the sales meeting prep workflow,” do not assume upcoming-meeting prep; offer: `Prep for an upcoming meeting`, `Overview of today's meetings`, and `Overview of tomorrow's meetings`.
    - If intent is "prep for an upcoming meeting" and the user did not supply a meeting, account, attendee, topic, or date, search, rank, and offer up to three candidates via `ask_user_input()`. Do not retrieve deeper context or draft a brief until the user selects one. All suggested events must be in the future relative to the user's current time.
        - This search should just be for the next 3 business days, with 25 max results, and no broad free-text query unless the user supplied an account, attendee, topic, or keyword
    - Resolve the account or workstream from the user request, invite, attendees, attendee domains, and nearby context. If CRM has multiple opportunities, use the one that matches the meeting topic, attendees, product, and recent activity; do not let an unrelated same-account opportunity drive the brief. If no credible anchor exists, state the gap instead of inventing one.
    - After the first draft, offer the most relevant follow-up from the Next Step Options below.

### Next Step Options

Use these as high-value transitions. Offer one clear transition, not a menu. Suggest ONLY these unless you are very confident another option is more useful:
- Install new connectors if they could materially improve output quality
- Improve or refine the brief based on the user's guidance.
- Add the prep to an existing meeting note or create a new meeting document as a pre-read. If needed and possible, offer to attach the document to the calendar invite. Be mindful of the broader audience when creating this prep doc; don't add your draft verbatim.
- Draft a concise Slack or email update for attendees, owners, or internal stakeholders.
- For `Daily Prep Digest` outputs, check whether a matching daily automation already reruns this `prepare-for-meeting` skill in that mode; if none exists, offer to create one that gives the seller a morning view of today's customer meetings, watchouts, and suggested closes.
- Set a heartbeat automation to follow-up with summary and action items after the meeting.

Next steps to avoid:
- Talk tracks or facilitation scripts

### Automation Offer Guard

For `Daily Prep Digest` outputs, a daily meeting-prep brief is the preferred automation offer when the user benefits from starting each day with a seller-ready view of customer, prospect, partner, renewal, opportunity, or high-stakes internal meetings. Frame the value in sales language: knowing which meetings matter today, what account or deal context changed, where the watchouts are, and how to close each meeting toward a concrete next step.

The automation must be a scheduled rerun of this skill, not a separate custom calendar summary. When creating or describing the automation, make the prompt call this skill directly and preserve the same digest shape:

```text
Use the Sales `prepare-for-meeting` skill in `Daily Prep Digest` mode.
Rerun it daily for today's qualifying seller meetings in the user's timezone.
Return the standard Daily Prep Digest output with chronological meeting briefs and priority watchouts.

mode: "Daily Prep Digest"
date: "today"
meeting_scope: "customer, prospect, partner, renewal, opportunity, or high-stakes internal meetings"
```

The recurring output should follow this skill's `Daily Prep Digest` format: today's meetings, each meeting's goal, key context, watchout, suggested close, and cross-meeting priority watchouts. Keep it read-only; it may recommend preparation and follow-up actions, but must not create meeting notes, attach documents, send messages, post updates, or write CRM unless the user separately asks and approves.

Before offering the daily prep brief, check whether the user already has a matching local automation installed. Inspect local automation records under `$CODEX_HOME/automations/*/automation.toml`, or `~/.codex/automations/*/automation.toml` when `CODEX_HOME` is unset, and match by name, prompt, skill name, mode, cadence, meeting scope, or other stable scope details. Treat active and paused matches as already installed.

- If a matching automation exists, do not suggest creating another one. Continue with the next most relevant non-automation follow-up.
- If no matching automation exists, end with one clear offer to check/create a daily rerun of `prepare-for-meeting` for the Daily Prep Digest. Describe the recurring output as a morning seller brief for the meetings that need attention, why each matters commercially, and the recommended close or next step. Do not create or update the automation until the user explicitly agrees.
- If the automation surface is unavailable, do not mention tool details; offer to help set up a recurring meeting-prep brief when automations are available.

## Overall Rules
- If asking the user a straightforward question where the set of potential answers are bounded and high-confidence, use the user_input form tool if available.
- Always cite sources using hyperlinks so users can click through to source docs

## Modes
### 1. Single Meeting Prep

- Use when the user names one meeting, account, attendee, invite, or topic.
- You can pull in relevant information from other related meeting and context, but ensure that you make the link to the target meeting clear.

#### Output Format

```md
# [Meeting Name]

**Date:** [Date / Time]
**Attendees:** [Names + roles]

## Summary

- [Core meeting objective]
- [Current account, opportunity, or workstream signal]
- [Top implication, risk, or source gap]

## Goal

[Specific outcome: decision, alignment, feedback, commitment, or next step.]

## Open Questions

- [Most important unresolved question]
- [Question tied to invite, CRM, notes, or message context]
- [Decision or clarification needed]

## Proposed Agenda

1. [Decision-oriented topic]
2. [Risk, blocker, or decision to resolve]
3. [Confirm next steps and owners]

## Background Context
[Max 4 bullets, non-overlapping with above]

- [Compact account, deal, or workstream context]
- [Relevant attendee or prior-meeting context with citation]
- [Useful assets, constraints, dependencies, and source gaps]


{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```

### 2. Daily Prep Digest

Use when the user asks for today’s, tomorrow’s, or another date-based meeting summary.

Start from calendar, apply the shared selection rules, keep qualifying meetings, and order them chronologically. Keep separate briefs for separate meetings.

### Output Format

```md
## Today's Meetings

### [Time] — [Meeting Name]

**Attendees:** [Names + roles]

- **Goal:** [What to accomplish]
- **Key context:** [Relevant account, deal, project, or workstream signal]
- **Watchout:** [Risk, blocker, dependency, or source gap]
- **Suggested close:** [Next step, owner, commitment, or decision]

## Priority Watchouts

- [Most important cross-meeting risk]
- [Meeting needing special preparation]
- [Missing context or follow-up needed before meetings]

---

{Follow the instructions and output format/conditions in [Limitations and Improvements](../index/SKILL.md#limitations-and-improvements)}

{Follow the instructions and output format/conditions in [Next Steps](../index/SKILL.md#4-next-steps)}
```
