# Sound review checklist

Run this only when the feature includes sound. It is part of the full-motion
pass in `SKILL.md`, not a separate review ceremony.

## Meaning and restraint

- [ ] Every cue maps to a documented, user-visible semantic event or state
      transition; no cue exists "because it sounds nice".
- [ ] Frequent actions (typing, scrolling, tab switching, back, repeated list
      selection) are silent or use platform-native feedback.
- [ ] No cue from recomposition, animation frames, polling, refresh loops, or
      background updates the user did not initiate.
- [ ] One winning cue per event; no overlapping or duplicate cue for one event.

## Timing and coordination with motion/haptics

- [ ] Sound onset aligns with the meaningful visual state change (typically
      completion), not with the start of a long animation.
- [ ] Duration does not outlive the interaction or add perceived latency; the UI
      never waits for playback.
- [ ] Haptic and sound, if both are chosen, fire at the same semantic moment and
      are not duplicated or sequenced.
- [ ] Cancelled or reversed motions play no success cue.

## User control and accessibility

- [ ] Mute/preference works, persists, and removes every in-app cue.
- [ ] Visual and semantic feedback still convey the outcome with sound off.
- [ ] System silent/DND, volume and audio focus behavior verified.
- [ ] Notification audio is governed by channel settings, separately.
- [ ] If a longer cue exists, focus and resource release are verified.

## Implementation and provenance

- [ ] Short one-shots use SoundPool (or a verified platform hook) and are
      preloaded, not decoded on the interaction path.
- [ ] Oboe / third-party audio dependencies are absent unless justified.
- [ ] Every asset has a catalog entry with source and license; no asset was
      copied without a verified right to redistribute.

Record the conclusion in the same evidence report as the motion pass, using
`sound-catalog-template.md` for the cue inventory.
