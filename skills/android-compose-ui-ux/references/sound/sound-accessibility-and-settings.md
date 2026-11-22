# Sound accessibility, settings and lifecycle

Custom sound is opt-in. The user can always remove it, and the app must remain
fully usable with no audio at all.

## User control

- Provide a persistent sound preference with an obvious **off** state when
  custom sounds are included. Store it across sessions; do not re-enable it on
  launch.
- Separate in-app feedback from notification sounds. Notification audio follows
  the channel and system notification settings, not the feedback toggle.
- Never auto-play ambient music or loops on launch unless the user explicitly
  asked for it and can stop it immediately.

## System behavior

- Respect device silent / DND state, system volume and audio focus. Do not bypass
  system volume or steal focus for a UI cue.
- For longer audio, handle focus gain/loss and pause or stop appropriately;
  release resources when the owning screen or player is destroyed.
- On configuration changes and process recreation, re-read the preference
  rather than assuming the previous playback state.

## Equivalent feedback

- Audio must never be the only carrier of information. Every outcome remains
  visually and semantically perceivable: text, icon, state description, or a
  TalkBack announcement where appropriate.
- Provide equivalent visual and, where appropriate, haptic feedback for the
  same event. If the sound is muted, the state change is still complete.
- Avoid startling, excessively loud, repetitive or high-frequency cues. Users
  with auditory sensitivity, in shared spaces, or with hearing loss are not
  edge cases.

## Review checks

- [ ] Muting feedback removes every in-app cue, including on rapid repeat.
- [ ] Silent/DND and volume changes behave as the system intends.
- [ ] The same outcome is conveyed visually and semantically with sound off.
- [ ] Notification audio follows channel settings, not the feedback toggle.
- [ ] No ambient audio starts without an explicit request.
- [ ] Focus and resource release verified for longer cues.

Cross-reference: `android-accessibility` for semantics/TalkBack; this file is
read only when the feature actually includes sound.
