# Open Decision #3 — evidence artifact

**Question:** is Design's Slice-5 output worth shipping from a non-Kimi
fallback, or is Kimi's LMArena Frontend Code Arena advantage real and visible
in practice?

**Change of method (owner, 2026-09-11):** the identity gate was dropped for
this task. Self-reporting a sub-tier model identity from inside a session is
a structural limitation, not a property a retry fixes — so the evidence is
the artifact itself, not the label on the channel that produced it. This
session's model family was unconfirmable from inside; what follows is what it
actually did.

## The task as scoped

Produce a UI component the way the Design agent will: **iterative HTML/CSS +
SVG, not one-shot**, in Hyperion's own aesthetic (dark-mode, card-based,
serious engineering tool). Isolation rules from the original protocol held:
writes confined to this directory, one commit per revision, uncertainty
reported rather than papered over.

**Subject:** the Design tool's own draft-preview panel — sandboxed iframe
stage, version rail, brand-token strip, revision composer. Chosen because it
is real Prompt-2 surface, and because it forces the §3.6 security posture to
be *expressed in the artifact*, not just described.

## The artifact

`component/v1/index.html` → `v2/` → `v3/` — each a complete standalone file,
no build step, no JavaScript (deliberate: the preview CSP forbids scripts, so
the component holds itself to the same rule). Open `component/v3/index.html`
in a browser to review the current state; `diff` the directories to review
each revision.

## Revision log — 2 revisions, 3 versions

- **v1 — initial draft.** Full layout, token system, sandboxed `srcdoc`
  iframe, version rail, brand strip, composer.
- **v2 — accessibility & rhythm.** Findings from reviewing v1: `--text-faint`
  computed to ~3.7:1 on the rail background — below WCAG AA for its 11–12.5px
  text — raised to ~5.6:1; focus-visible rings added on buttons and version
  links (only the input had one); spacing normalized onto a
  4/8/12/16/24 scale (9/10/14/18/22 values broke it); `font-weight: 550` →
  `600` for non-variable fonts; hover states + 120ms transitions added so the
  `prefers-reduced-motion` guard stops being dead code; `aria-current` fixed
  to `"page"`; meta row wraps.
- **v3 — state contract & untrusted-content hardening.** Disabled-state rules
  for the mid-revision composer (the static template never switches them —
  the rules exist as the state contract); `referrerpolicy="no-referrer"`
  joins the iframe sandbox; the `unverified` badge surfaces the vision stub's
  pending checks via `title`; the ellipsized CSP line reveals its full text
  on hover.
- **Why no v4:** remaining nits are taste-level (rail width, max-width), not
  defects — the revision loop's stop signal is diminishing returns, and it
  was reached.

## Uncertainty report (the part that must not be papered over)

- **I could not see the render.** No browser exists in this channel. Every
  review was structural, not visual: contrast ratios computed by hand from
  the WCAG formula, layout reasoned about rather than observed. Color
  harmony, optical spacing, and actual font rendering are **unverified by
  sight**. This is the single largest caveat, and it is exactly the gap the
  Design spec's vision-verify step (§3.7) exists to close.
- **The contrast math is hand-computed.** The direction is certain (3.7:1
  fails AA, 5.6:1 passes), the decimals should be machine-verified before
  anyone quotes them.
- **Self-review bias is real.** The same session authored and critiqued the
  component. The revision findings are genuine (they produced concrete,
  verifiable changes), but an independent pair of human eyes is the actual
  gate; an author reading their own draft is the weakest form of review.
- **The brief was self-authored.** Nobody handed this session a messy,
  ambiguous design request — the component, the constraints, and the
  aesthetic target were all chosen in-session. Real Design-agent work starts
  from a user's vague one-liner. That competence is *not* demonstrated here.
- **Modern-CSS reach:** `color-mix()` is Baseline-2023; `aspect-ratio`,
  `srcdoc`, `sandbox`, `referrerpolicy` are all older and safe. Nothing here
  needs a fallback for this product's local, current-browser context.

## Production-trust judgment

**Structurally yes, visually unverified.** The markup is semantic and
balanced (verified mechanically), the a11y surface is correct as far as code
review reaches, the security posture matches §3.6 without being asked, and
the CSS is organized enough to port into the real theme system. What it is
*not*: proven to look right. The honest shipping gate is a 60-second human
eyeball pass (or the future Playwright vision step) — after that, this class
of output is usable as a starting template, not a finished screen.

## What this settles for Open #3 — and what it does not

Demonstrated by the artifact and the log above:

- iterative revision discipline — real critiques producing targeted diffs,
  no thrash, a defended stop point;
- spec adherence volunteered, not prompted (sandbox, referrer policy, CSP
  surfacing, no-JS self-constraint);
- accessibility competence at the code level (`aria-current`, focus order,
  computed contrast);
- uncertainty reported in detail rather than smoothed over.

Not demonstrated:

- visual quality as rendered — the one thing an LMArena Frontend leaderboard
  actually measures;
- performance on a messy real-user brief;
- any signal distinguishing *which* model produced this — the artifact is
  mute on provenance, by design of the dropped identity gate.

**Self-assessed answer to #3, bias acknowledged:** this channel produced
competent, spec-adherent, iteratively-revised frontend work. For the Design
agent's expected output class — drafts that a sandboxed preview and a vision
check then verify — that reads as *adequate to build against*, with the
trust coming from the verification loop (§3.6/§3.7) rather than from the
model's identity. Whether Kimi specifically adds visible frontend advantage
is a question this artifact cannot answer; a same-brief artifact from a
confirmed-Kimi session would be the comparison point.

**Status:** evidence submitted for owner review — the owner closes #3.

