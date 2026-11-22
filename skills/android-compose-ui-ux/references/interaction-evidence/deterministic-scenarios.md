# Deterministic interaction scenarios

Use the app's existing debug hooks, Maestro flows, and test-only entry points
where possible. The goal is a repeatable **state transition** sequence that can
be replayed with the same settings, not a claim about exact audio samples on an
emulator that has no audio hardware.

Run each scenario once with normal feedback settings and once with reduced
motion on. For features with custom sound, also run with `audioPreference`
enabled and disabled (see scenario 7).

## 1. Rapid double tap / repeated toggles

Double-tap the primary action, then toggle the same state three to five times
quickly. Verify exactly one commit per intentional action, no stuck intermediate
state, no duplicated success cue, cooldown honored for repeated feedback, and no
stutter. Link one frame reference to the record's `frame` field.

## 2. Gesture cancellation and spring retarget

Start a drag or swipe, move past the threshold, then reverse or release below
it. Verify the motion follows the finger, the spring retargets from the current
position (no snap-and-restart), and cancellation plays **no** success cue or
haptic. Repeat with a fast fling seeded with velocity.

## 3. Navigation: forward, back, predictive back

Push a screen, go back via system back and via predictive back, and re-enter the
same screen. Verify entrances are gated by first reveal (no replay on back), the
transition direction matches semantics, and RTL is mirrored. Any navigation
cue belongs to the committed destination, not the gesture start.

## 4. Bottom/side sheet: open, partial drag, cancel, dismiss

Exercise all four outcomes: open to full anchor, partial drag then settle,
partial drag then cancel, and swipe dismiss. Verify scrim/anchored spring
tracking, no cue on the cancel path, and a single cue on a committed dismiss.

## 5. Loading success / failure transition

Drive both branches with a stubbed or debug-controlled result. Verify the
teleport-swap anti-pattern is absent (crossfade + rise, not spinner then instant
content), the outcome is conveyed visually and semantically, and any result
sound fires only when the transition actually commits. Failure must not reuse
the success cue.

## 6. Reduced motion enabled

Turn on Developer options → Remove animations (and any app-level reduced-motion
setting). Every flow reaches its final state instantly with no invisible or
stuck state. Optional sound/haptics may remain if the user has not disabled
them, but their meaning must never depend on the removed motion.

## 7. Sound preference on / off (only for custom-sound features)

Run the same cue-bearing flow twice: `audioPreference` enabled and disabled.
With sound on, verify the cue maps to a documented `cueId` and fires at state
completion. With sound off, verify **no** in-app cue fires while the visual and
semantic outcome is unchanged. No cue may originate from recomposition,
animation frames, polling, or background refresh in either pass.

## 8. Lifecycle interruption (longer audio only)

Only when the feature plays audio longer than a one-shot: background and resume
the app mid-playback, rotate, and change audio focus. Verify pause/resume and
resource release behavior. Short UI one-shots skip this scenario and record it
as `not-applicable`.

## Capturing the runs

- Screen-record each pass end to end into the capture archive; save key frames
  as screenshots and link a named baseline where visual comparison is useful.
- **Detect and report audio capability before claiming audio evidence.** Check
  for real audio hardware / loopback or a validated capture path. If absent,
  record `audio.waveform` as `unavailable`, use manual listening plus the
  documented expected behavior, and test state transitions instead of exact
  audio output.
- Test state transitions, not exact audio output on unsupported emulators. A
  failed capability check is a reported limitation, never a silent pass.
