# Sound tokens

Sound roles are named tokens in an app-level catalog, not inline magic values.
Keep them beside `MotionTokens.kt` so motion and feedback are reviewed together.
The ranges below are starting points for short UI one-shots; tune them against a
real device and the product's existing voice.

| Token role | Meaning | Starting gain (0–1) | Duration | Attack / decay |
| --- | --- | --- | --- | --- |
| `select` | Meaningful selection changed | 0.08–0.15 | 40–80 ms | instant / 40–70 ms |
| `toggle_on`, `toggle_off` | Distinct on/off state | 0.10–0.18 | 60–100 ms | 0–3 ms / 50–90 ms |
| `confirm` | User action completed | 0.12–0.22 | 90–160 ms | 2–5 ms / 70–150 ms |
| `reject` | Correctable failure | 0.10–0.18 | 80–140 ms | instant / 60–120 ms |
| `navigate` | Optional continuity cue | 0.06–0.12 | 60–120 ms | 3–6 ms / 50–100 ms |
| `notify` | External event, channel-governed | 0.15–0.25 | 120–250 ms | 5–10 ms / 100–200 ms |

## Priority and cooldown

- Priority: `reject` > `confirm` > `toggle` > `select` > `navigate`. A higher
  priority cue replaces a lower one in flight; never layer them.
- Cooldown: 250–500 ms for repeated instances of the same role; if a gesture
  can fire faster than the cooldown, the action should be silent instead.
- One cue per semantic event. A single click must not produce both `select` and
  `confirm` unless those are genuinely two different state changes.
- Keep peak output below the level that startles or competes with speech;
  respect system volume rather than raising it from code.

## Relationship to motion tokens

- A cue's onset is tied to the visual state that changed, not to a fixed
  animation offset. If a 320 ms transition commits at its end, the sound starts
  at commit — not at press and not at frame 0.
- When motion is cancelled or retargeted, the corresponding confirm cue is
  cancelled with it.
- If haptic and sound are both chosen, fire them in the same frame of the state
  transition; do not sequence one after the other.

Record each token's asset, source and license in `sound-catalog-template.md`.
Never ship an asset without that provenance entry.
