# Anti-Slop Patterns

A checklist of patterns that make AI-generated design read as AI-generated. Not because any individual pattern is *wrong* — most were once fresh — but because they've become the median move and now signal "no designer thought about this specifically."

Run through this list at the end of every blueprint. If a pattern hits, either (a) fix it, or (b) surface it as a Decision Trace entry with an explicit reason for keeping it.

Structure: **the pattern** → **why it reads as slop** → **the move that clears it**.

---

## Universal — appears across artifact types

### U1. The gradient hero background
**Pattern.** A hero section with a purple-blue-cyan (or now teal-pink-orange) gradient, sometimes animated, sometimes with a subtle radial glow. Text over the top in white sans-serif.
**Why it's slop.** It was the Stripe default in 2019 and has propagated to every SaaS landing page since. Now it reads as "we did not know what else to put there."
**The move that clears it.** Either replace with a single solid color chosen deliberately (a saturated one, or an unusual neutral) or with real content that carries the visual weight (photography, a product screenshot, a typographic composition). If a gradient is truly the right move, use a *specific* one — two adjacent hues, or two hues at unusual angle, and treat it as a Decision Trace entry.

### U2. The rounded-16px-shadow-sm card grid
**Pattern.** A 3×N or 4×N grid of white cards, each with rounded 16px corners, a subtle drop shadow, an icon at the top, a heading, and 2–3 lines of body text.
**Why it's slop.** The Bootstrap→shadcn pipeline standardized this so hard that seeing it now means the designer didn't want to make a choice.
**The move that clears it.** Try: inline typographic rhythm (headings + body flowing top-to-bottom, no boxes), a real 2D grid (asymmetric sizes), or bordered cells with 0px radius. If you must use cards, break at least one rule of the default (no shadow, or 0px radius, or overlapping edges).

### U3. Emoji as decoration
**Pattern.** Section headers, feature lists, or callouts prefixed with an emoji (⚡🎯💡🚀). Present on every section.
**Why it's slop.** ChatGPT-style formatting invaded design; emojis on headers signal "written by an LLM, styled by no one."
**The move that clears it.** Remove. If you need visual anchors, use typography (an eyebrow label, a number, a rule). Reserve emoji for content it's actually functional in (a chat interface, a reaction feature, a social post preview).

### U4. Isometric 3D people illustrations
**Pattern.** Purple/blue/orange gradients on rounded 3D-effect people at desks, high-fiving, on rockets, holding oversized icons.
**Why it's slop.** Corporate illustration circa 2018–2022, still dominant in AI image generation. Read as "we bought this from a stock library."
**The move that clears it.** Real photography (with a real photographic style, not stock), or hand-drawn illustration in a defined style (line weight, palette, treatment consistent across all illustrations), or *no illustration*. "No illustration" is a real design choice and often the strongest one.

### U5. "Growing number stat" trios
**Pattern.** `47%` in huge type, `YoY revenue growth` below in small type, three of these side-by-side, gradient accent on the numbers.
**Why it's slop.** Every SaaS landing page. The stats are usually made up.
**The move that clears it.** If real numbers matter, integrate them into a sentence or a chart, not floating stat cards. If they're aspirational, remove them.

### U6. Every action gets a primary button
**Pattern.** "Sign up," "Learn more," "Watch demo," "Read docs," "Book a call" — all as filled saturated-color rounded buttons of similar visual weight.
**Why it's slop.** Hierarchy collapses; the user's eye can't tell what's actually the primary action.
**The move that clears it.** One filled button per screen. Others become text links, ghost buttons, or plain hyperlinks. If they all *look* equally important, none of them *are*.

### U7. Words that don't say anything
**Pattern.** "Seamlessly unlock your team's potential." "Elevate your workflow." "Journey to insights." "Delight your customers."
**Why it's slop.** These phrases are copyright-free everywhere. They mean nothing and signal AI-generated copy or lazy copy.
**The move that clears it.** Replace with a sentence that's true, specific, and could only be said about this one product. "Close the books three days faster" beats "streamline your finance workflow."

### U8. Em-dash overuse
**Pattern.** — Every — sentence — has — an em-dash — for — dramatic — effect.
**Why it's slop.** Currently the strongest visual tell of LLM-written copy.
**The move that clears it.** At most one em-dash per paragraph. Prefer commas or periods.

---

## Slide-deck specific

### S1. The template "Agenda" slide
**Pattern.** Slide 2 of every deck: title "Agenda," three bulleted items, sometimes numbered.
**Move.** Either skip (the audience will find out what's in the deck by watching it) or replace with a genuinely useful structural device (a visual roadmap, a question the deck answers).

### S2. "Thank you" slide with contact info
**Pattern.** Final slide: "Thank you!" giant, plus email/website in small type.
**Move.** Either end on the actual concluding thought slide (whatever the deck's real ending is) or, if you need a close-out, make it a slide with one strong question or one strong statement — the takeaway, not the sign-off.

### S3. Bullet lists as the default content pattern
**Pattern.** Every slide is Title + 4 bullets.
**Move.** Force yourself to render at least half of the slides as either (a) a single sentence, (b) a chart, (c) an image with a caption, or (d) a table. Bullets are one option, not the default.

### S4. Bullet reveals / build animations
**Pattern.** Bullets appear one by one on click.
**Move.** For read-along decks: no reveals. For speaking decks: only reveal if the reveal is doing narrative work — otherwise it's the equivalent of the speaker reading the slide.

### S5. Every slide has the company logo in a corner
**Pattern.** Logo top-right on every slide, watermark-style.
**Move.** Put the logo on the title slide and the closing slide. That's it. The audience remembers.

---

## Landing page / web specific

### W1. The "How it works" three-step section
**Pattern.** Three numbered cards: "1. Sign up. 2. Configure. 3. Enjoy the magic." with pastel icons.
**Move.** If the product's process is genuinely three steps and this is the best way to convey it, keep — but rewrite the copy so it's specific (not "enjoy the magic"). Usually, though, the process is either irrelevant to the pitch or more than three steps, and this section is filler.

### W2. Testimonial carousel
**Pattern.** Auto-scrolling row of quotes with round headshots.
**Move.** One or two testimonials, statically placed, with real names and companies. If the testimonials aren't strong enough that you'd want them static, don't include them.

### W3. FAQ accordion at the bottom
**Pattern.** 6–10 collapsible questions covering pricing, support, integrations.
**Move.** If FAQ genuinely converts, keep — but the questions should be the ones users actually ask, and the answers should be one line. Long accordion FAQs read as SEO padding.

### W4. Trust logos strip
**Pattern.** "Trusted by these companies" + row of grayscale logos.
**Move.** Either integrate customer names into real copy ("Ramp uses this to close their books three days faster") or drop entirely. Grayscale-logo-strips have been overplayed to meaningless.

### W5. Feature grid with icon + heading + two lines
**Pattern.** 6 features in a 3×2 grid, each with a stroke icon, feature name, two-line description.
**Move.** Pick the top 2 features and give each a full section with real detail. Or convert the whole grid into a table if that's what the information wants. Or convert to inline typographic list without the boxes.

### W6. Sticky nav with too many items
**Pattern.** Product / Solutions / Pricing / Resources / Customers / Company / Blog / Docs / Login / Sign up
**Move.** 3–4 nav items max. If you need more, use a mega-menu but earn it. "Solutions" as a nav item is nearly always slop.

---

## Poster / single-frame specific

### P1. Center-aligned symmetrical composition by default
**Pattern.** Title centered, subtitle centered, date centered, location centered, sponsor logos centered at the bottom.
**Move.** Break the symmetry deliberately. Anchor one element and calibrate the rest against it. If the composition ends up symmetrical, that was a decision.

### P2. Big Bold Sans + horizontal divider
**Pattern.** Enormous condensed sans-serif title, thin horizontal line under it, everything else below.
**Move.** Try: the title *is* the composition (typography as image), or type is small and something else is the visual anchor, or type wraps and interacts with an element.

### P3. Photo with a 30% dark overlay + text on top
**Pattern.** Full-bleed photograph, dark overlay to make white text readable.
**Move.** Either the photo is the thing (no text on it, text elsewhere) or the type is set into the photo (in a gap, alongside it, or the photo is designed with type-space in mind). If you *must* overlay text, place it in a specific spot the composition supports, not centered blindly.

### P4. Corner decorations
**Pattern.** Small dots, arrows, ornament flourishes in the four corners.
**Move.** Remove. Corner decoration was earning its keep in 1970s poster design and hasn't since.

---

## Chart / data-viz specific

### C1. Legend that duplicates direct-labelable info
**Pattern.** A two-line chart with a color-coded legend saying "Line 1: Revenue, Line 2: Costs."
**Move.** Put the labels on the lines themselves.

### C2. Dual y-axis
**Pattern.** Two data series with unrelated units, sharing one chart with a left y-axis and a right y-axis.
**Move.** Almost never correct. Make two small charts side by side. Or, if the point is correlation, use a scatter plot.

### C3. Rainbow color scale for non-rainbow data
**Pattern.** Sequential data (revenue by month, temperature by year) colored red-orange-yellow-green-blue.
**Move.** Use a sequential single-hue scale (light-to-dark blue, or ColorBrewer). Rainbow is only for genuinely ordered rainbow-like variables and even then debatable.

### C4. Chart title = the variable name
**Pattern.** Chart titled "Sales by Region."
**Move.** Title = the takeaway. "Sales grew fastest in APAC in Q3."

### C5. Pie charts with more than 4 slices
**Pattern.** A pie chart with 7 categories, some 3% wedges, a legend.
**Move.** Bar chart, or stacked bar chart, or lump the tail into "Other." Pie charts encode angle badly and get worse with more slices.

---

## Dashboard / UI specific

### D1. KPI card row at the top
**Pattern.** 4–6 cards across the top: "Revenue: $X ↑12%," "Users: X ↑5%," each with a sparkline and a percentage change badge.
**Move.** Fewer, larger metrics. Chart the ones that matter. Don't put every possible number in a card just because you can.

### D2. Every panel is 12-col-half-width
**Pattern.** Two-column grid, each panel is one chart, all charts are the same size.
**Move.** Panel sizes should reflect information importance. Give the most important chart 3× the space of a supporting one.

### D3. Empty state that just says "No data"
**Pattern.** Empty view: gray icon, "No items yet," period.
**Move.** Empty states teach. Show the primary action, an example of what a populated state would look like, or a hint of what data will appear.

### D4. Global filters at the top, applied to nothing visible
**Pattern.** Date range picker + segment dropdown at the top of the dashboard, but no visual indicator of which panels are filtered.
**Move.** Either show the filter state in each panel's header, or scope filters to a specific block visually.

---

## Voice / copy patterns (cross-artifact)

### V1. Rhetorical questions in headers
**Pattern.** "Ready to transform your workflow?" "What if data could tell a story?"
**Move.** Replace with a statement. Rhetorical questions are the "hey, buddy" of copywriting.

### V2. Two-word verbs to make things sound bigger
**Pattern.** "Level up," "double down," "reach out," "roll out," "sync up."
**Move.** Use the single verb.

### V3. "Powerful, intuitive, seamless"
**Pattern.** Trio of adjectives that mean nothing when stacked.
**Move.** Pick zero. Show it instead.

### V4. Sentence-case titles pretending to be product-tour interfaces
**Pattern.** "Manage your team effortlessly with real-time collaboration."
**Move.** Cut to what the feature actually does. "Team members see edits as you type."

---

## How to run the anti-slop pass

Fast pass. 60 seconds. Ask three questions of the blueprint you just wrote:

1. **What's the most-common move in this design?** Whichever section, layout, or copy phrase you can imagine seeing on ten other websites this week — that's the candidate for revision.
2. **Which decisions did I *not* make?** If a section, choice, or component just appeared without a Decision Trace, it's a default. Defaults are where slop lives.
3. **What would the specific designer I embodied refuse?** Re-read their "refuses" list in `embody-modes.md`. Any hit is worth calling out.

If a hit is found, don't hide it. Either fix in place, or note it as a deliberate trade-off in the Decision Trace with the reason. Both are fine. Silent slop is not.
