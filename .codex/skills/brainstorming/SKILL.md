---
name: brainstorming
description: "Agmo design-first brainstorming workflow. Use for idea exploration, design tradeoffs, and requirement shaping before plan or implementation."
argument-hint: "[idea, design problem, or feature direction]"
---

# Brainstorming

Use this when the user wants to explore an idea, compare approaches, or shape a design before planning or implementation.

`brainstorming` is the canonical first-stage workflow name. Requests phrased as `design` should be treated as compatibility alias routing into this same lane, not as a separate stage.

## Main-session contract

The main session is the orchestrator. Do not become the primary implementation worker here.

When `$brainstorming` is invoked, the main session should:

1. Gather brownfield context first
   - inspect relevant files directly or with `agmo-explore`
   - check vault context when earlier design/plan notes matter
2. Delegate the design exploration pass to the best-fit worker lane
   - primary: `agmo-planner`
   - optional support: `agmo-explore` for repo facts
3. Synthesize the delegated result back into a user-facing design conversation
4. Keep implementation blocked until the design is explicitly accepted

## Hard gate

- Do **not** start implementation from this skill.
- Do **not** hand off to `$execute` or `$team` until the design direction is accepted.

## Questioning style

Borrow the high-value parts of deep-interview, but keep this workflow lighter than a full interrogation.

Ask **one question at a time** and prioritize:

1. **Intent** — why this matters
2. **Outcome** — what “good” looks like
3. **Scope** — what should change
4. **Non-goals** — what must stay out of scope
5. **Decision boundaries** — what the agent may decide vs what needs approval
6. **Constraints** — technical/business limits

Before asking about repo internals, inspect the codebase yourself. Prefer evidence-backed prompts such as:

- “I found X in Y. Should the new design extend that pattern?”
- “Current flow already does A. Is the new design allowed to diverge?”

## Pressure pass

Before finalizing the design, do at least one deeper follow-up that forces clarity:

- ask for an example or counterexample
- expose a hidden assumption
- force a tradeoff or scope boundary

Do not just collect surface-level preferences.

## Design output shape

Once intent and boundaries are clear, present:

1. **2-3 approaches** with tradeoffs
2. A **recommended direction**
3. A structured design broken into:
   - architecture
   - data / control flow
   - failure handling
   - scope boundaries / YAGNI

For each section, keep it proportional to task size and pause for confirmation when needed.

## Transition rules

After design approval:

- hand off to `$plan` as the normal next step
- only bypass directly to `$execute` when an execution-ready plan already exists and the user is explicitly moving into implementation
- if ambiguity remains materially high or the user explicitly asks for a rigorous interview, escalate to `$deep-interview`

## Evidence and durability

- Prefer citing the files/patterns that informed the design
- Preserve the approved design as the durable source for downstream plan/execute work
- Expect Agmo autosave to persist the brainstorming result into the design note lane
