# Motion Review Checklist

Run this end-to-end before declaring any motion task done. Every "no" is a fix, not a note.

## Purpose & scope
- [ ] Each animation answers one of: enter / exit / state / continuity / feedback (SKILL.md §1.1).
- [ ] One hero per screen change; supporting motion is faster/smaller/just fades.
- [ ] No decorative loops except progress indicators.
- [ ] Scope didn't grow: ≤ 3 distinct new motions per task (unless user asked for more explicitly).

## Timing
- [ ] All durations/easings/springs come from `MotionTokens` — zero magic numbers left (`grep -rE "tween\([0-9]{3}\)|duration = [0-9]{3}"` should return only token definitions).
- [ ] Structural motion ≤ 400 ms; hero ≤ 500 ms; nothing feels like "the app is thinking".
- [ ] Exits are 25–40% shorter than entrances and mostly fade.
- [ ] Stagger windows ≤ 350 ms total; per-item 12–30 ms.

## Feel
- [ ] Bounce appears at most once per screen, only on a playful micro-interaction.
- [ ] No linear easing on enter/exit; loops use linear/soft pulse.
- [ ] Direction matches semantics (forward/back, increment/decrement, RTL mirrored).
- [ ] Press feedback present on primary touchables; ripple retained everywhere.
- [ ] Sequence count: no event triggers > 2 chained animations.

## Interruption & state
- [ ] Rapid re-trigger tested (double-tap the button, toggle twice fast, mash like) — no stutter, no double-run, no stuck state.
- [ ] Retargeting uses `animate*AsState`/`animateTo` (not snap+restart), except gesture tracking.
- [ ] No entrance replays on rotation, theme change, or back-navigation (gated by first-reveal state).
- [ ] Gesture motions track the finger 1:1; animation only on release, seeded with velocity.

## Performance
- [ ] Only transform/opacity/elevation animated; no per-frame layout (no animated `padding`/`width`/`height` outside `animateContentSize`).
- [ ] Compose: animation state read in `graphicsLayer { }` (draw phase), not composition; Layout Inspector shows no steady-state recomposition during animations.
- [ ] Views: no animators leaking on detached views; `withLayer()` used for complex multi-property moves.
- [ ] No jank on the touched flows (measured if in doubt — see perf reference §4).

## Accessibility & settings
- [ ] "Remove animations" ON: every flow reaches complete final states instantly; nothing invisible/stuck.
- [ ] Reduced-motion provider wired for Compose (Compose ignores the system scale by itself).
- [ ] No information exists only in motion; static final layout carries all meaning.
- [ ] Focus/TalkBack order stable during animations; content descriptions correct at state-change time (play/pause morph etc.).
- [ ] Both light and dark themes verified (scrims, glows, crossfade contrast).
- [ ] RTL verified (offsets mirrored, stagger follows reading order).

## Code quality
- [ ] Animations are state-driven where possible; imperative `Animatable` only for one-shots/gestures.
- [ ] Named by purpose (`listEntranceStagger`, not `animation2`); composable modifiers extracted and reused (e.g., `pressScale()`).
- [ ] No new motion dependencies added without explicit user approval.
- [ ] Tests: key interactions pass with `mainClock` time control; reduced-motion path asserted.

## The thumb test (final)
- [ ] Use the app for 60 seconds like a real user. Everything responds within a beat, nothing wobbles, nothing waits, the app feels *quietly confident*. If any moment made you notice the animation instead of the task, go back and restrain it.
