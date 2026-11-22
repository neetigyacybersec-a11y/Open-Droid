# Sound design system

Sound is optional feedback, not decoration. **Default to silence.** Add a cue
only when it carries information the user would otherwise miss; name that
information before choosing an asset. A polished app that never sounds is a
valid outcome. "It feels premium" is not a reason to add sound.

## When to sound: four-way decision matrix

| Situation | Choice | Reason |
| --- | --- | --- |
| Frequent or low-stakes action: typing, scrolling, tab switching, back, repeated list selection | **Neither** (or platform-native feedback only) | Repetition turns feedback into noise; the visual state already communicates it. |
| A meaningful step threshold or confirmable state change, but no product sound language | **Haptic** | A short native tick is enough and respects silent mode without an audio asset. |
| A user-initiated completion with a documented semantic event and a restrained product sound language | **Sound** | The cue identifies a real outcome that the visual alone does not emphasize. |
| The same completion where a deliberate audible + tactile signature is part of the product identity | **Both** | Fire one cue of each kind at the same semantic moment, never two of the same kind. |

If none of the rows fits, the answer is Neither. Ask what changed for the user,
not what would be fun to play.

## Semantic cue families

- **Selection** — only when selection itself changes meaning (not every list row).
- **Toggle** — an optional short on/off distinction; never on every recomposition.
- **Confirm / success** — a completed action the user initiated.
- **Error / rejection** — distinguish a correctable mistake from a destructive or
  system failure; never use an alarming cue for a minor validation message.
- **Navigation / transition** — only when it improves spatial continuity.
- **Notification** — separate from in-app interaction feedback and governed by
  notification-channel settings.
- **Ambient / loop** — opt-in and rare; no decorative loop in a productivity app.

## Restraint and frequency gate

- Sounds are rare, short, low-volume and semantically distinct.
- No cue for recomposition, animation frames, polling, data refresh loops, or
  background updates the user did not initiate.
- One winning cue per event. If two rules match, the higher-priority rule wins;
  never stack cues.
- Prefer visual + native haptic feedback when that already communicates a
  frequent action completely.
- A cancelled or reversed motion must not play its success cue. Play on the
  state that actually committed, not on the gesture that started.

## Timing and coordination

- Onset aligns with the meaningful visual state change (typically completion),
  not with the start of a long animation.
- Duration must not outlive the interaction or create perceived latency. Never
  block the UI waiting for playback.
- Haptics and sounds are coordinated, not duplicated or fired at different
  semantic moments. Use the matrix above to decide whether both belong at all.
- If reduced motion or reduced feedback settings are active, keep the meaning in
  the visual/semantic layer and drop the optional cue.

See `sound-tokens.md` for starting gain/duration values,
`android-audio-implementation.md` for native APIs, and
`sound-accessibility-and-settings.md` for user control and system behavior.
