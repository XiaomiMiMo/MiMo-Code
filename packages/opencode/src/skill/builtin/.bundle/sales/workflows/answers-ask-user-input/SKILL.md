---
name: answers-ask-user-input
description: "Use when a small amount of missing context would materially improve the answer and tappable options plus a free-text answer can gather it efficiently."
---

# Ask User Input

## `ask_user_input`

purpose: present tappable options plus a free-text option to gather user preferences before providing advice. display interactive buttons that users can tap to answer, and include a concise placeholder for the free-text answer row.

when to use this tool:
- use for elicitation -- when you need to understand the user's preferences, constraints, or goals to give useful advice
- examples:
  - "help me plan a workout routine": ask about goals (strength/cardio/weight loss), time available, equipment access
  - "help me find a book to read": ask about genres, mood, recent favorites
  - "I'm thinking about getting a pet": ask about lifestyle, living situation, time commitment
  - "help me pick a gift for my friend": ask about occasion, budget, friend's interests

question quality requirements:
- each question should uncover a concrete preference, constraint, or tradeoff that would actually change your recommendation. If the answer would only restate which option the user already seems to prefer, the question is not useful enough.
- do NOT ask proxy questions whose options map directly onto the candidate recommendations the user is already comparing. Ask about decision factors beneath those labels instead: daily tasks, budget, timeline, schedule, risk tolerance, social setting, maintenance burden, or dealbreakers.
- avoid vague umbrella axes that bundle multiple dimensions into one abstract tradeoff. Prefer one concrete dimension per question so the user's tap gives you an interpretable signal.
- examples:
  - bad: user asks "Should I be an EMT or a firefighter?" and you ask "How do you feel about physical intensity vs medical focus?" with options that correspond to firefighter vs EMT.
  - better: ask "Which day-to-day work sounds more appealing?" with options about patient care, rescue/fire response, shift/station environment, or training timeline.

free-text placeholder requirements:
- every question MUST include free_text_placeholder
- make the placeholder short, concrete, and specific to the question, such as "Add another constraint" or "Describe your ideal pace"
- do not use generic placeholders like "Type your answer" unless the question truly has no more specific hint

when NOT to use this tool:
- user asks "A or B": they want your analysis and recommendation, not the options repeated back as buttons
- user is venting or processing emotions (e.g. "I'm having a bad day"): just listen and respond supportively
- user asks for your opinion (e.g. "what do you think of eggs?"): give your perspective directly
- factual questions (e.g. "what's the capital of France?"): just answer
- user needs prose feedback (e.g. "review my email"): provide written analysis
- user already gave you a detailed prompt with specific constraints: they've already done the narrowing themselves; asking for more second-guesses them. Proceed with their constraints and state any assumption you make inline

key instructions:
- always include a brief conversational message before presenting options -- don't show options silently
- you can ask up to 3 questions. Three is a ceiling, not a target.
- use 2-4 short, distinct options per question. You can use up to 10, but prefer 2-4.
- after calling this tool, your turn is done. Don't keep writing.
- prefer asking questions that can be multi-select. Most questions aren't mutually exclusive.

Invocation:
// Insert directly:
genui{"ask_user_input": {"questions": {...}}}
// This widget is not eligible for UUID Mode.

Example:
genui{"ask_user_input":{"questions":[{"question":"What matters most for this recommendation?","options":["Lower cost","Less effort","Best quality"],"type":"multi_select","free_text_placeholder":"Add another priority"}]}}

Args schema:
```text
// AskUserInputWidgetData
{
// Questions
//
// Ordered list of one-question pages to render.
// minItems: 1
questions: Array<
// AskUserInputQuestion
{
// Question
//
// Question shown to the user on this page.
question: string,
// Options
//
// Short answer options rendered as tappable choices.
options: string[], // minItems: 2, maxItems: 10
// Type
//
// Whether the user should pick one option or any number of options. Prefer wording questions as multi_select unless the answer is clearly only one choice.
type: "single_select" | "multi_select",
// Free Text Placeholder
//
// Short placeholder label for the free-text answer option shown below the tappable choices. Make it specific to this question.
free_text_placeholder: string,
}
>,
}
```
