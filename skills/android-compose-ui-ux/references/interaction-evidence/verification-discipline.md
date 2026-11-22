# Verification discipline

A review conclusion is only as strong as the evidence behind it. Keep the four
evidence types separate in the record and in the write-up; never let one stand
in for another.

## Four distinct evidence types

| Type | What proves it | What it does not prove |
| --- | --- | --- |
| **Visual** | Screenshot / named baseline comparison, both themes, scaled fonts. | Motion, haptics, sound. A screenshot cannot prove interaction feel. |
| **Motion** | End-to-end recording scrubbed frame by frame; rapid input, cancellation, reduced motion; perf measurement when in doubt. | Sound correctness; haptic hardware behavior. |
| **Haptic** | Observed single cue on the committed state change, settings honored, absence on scroll/recompute/cancel. | Audible output; visual layout. |
| **Audio** | Manual listening with a documented expected cue, or waveform analysis **only** when a validated capture path exists. | Visual or motion quality. Video without a captured audio track proves nothing about sound. |

## Claims that are not allowed

- A build pass does not imply motion or audio verification. Compilation proves
  code compiles, nothing about how it feels or sounds.
- Screenshots do not prove audio behavior, haptics, or motion.
- A video does not prove sound correctness unless the audio track was actually
  captured and listened to. If there is no loopback or capture path, say
  `unavailable` — **do not claim automated sound-waveform analysis**.
- A successful Maestro flow does not prove aesthetic quality; review the
  rendered output and the recording.
- Report `unavailable`, `skipped`, `not-applicable` and `failed` distinctly. An
  unchecked box is not a pass; a missing device capability is not a defect in
  the app and not a green result.

## Evidence hygiene

- Preserve original captures. Link each defect in the record to a specific
  screenshot path, recording path, frame index or timestamp.
- Reuse the existing capture archive and named baselines. This reference adds
  an interaction record next to them; it is **not a second baseline store** and
  does not duplicate screenshot-diff work.
- Write the conclusion from the record, not from memory. State device, variant,
  settings and status vocabulary verbatim so a reviewer can reproduce the run.
- If a cue could not be heard because the emulator has no audio hardware, say
  so, and rely on state-transition verification plus documented expected
  behavior until a validated audio capture path exists.
