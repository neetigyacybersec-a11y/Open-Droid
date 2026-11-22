# Native Android audio implementation

Default to the simplest platform API that can do the job. UI feedback sounds
are short one-shots, not media playback.

## Short one-shot UI SFX: SoundPool

- `SoundPool` is the default recommendation for short, preloaded interaction
  cues. Load and decode assets during setup (or a warm-up screen), never inside
  the click handler; the interaction path should only call `play`.
- Keep one app-level abstraction (for example `UiSoundPlayer`) so features do
  not each create their own player. It exposes semantic roles from
  `sound-tokens.md`, not raw resource IDs.
- Respect the cooldown and priority rules in the token catalog; drop a cue when
  its cooldown is active instead of queueing it.
- Release the player and its resources with the owning lifecycle; never leak a
  player across screens or process state.

## Platform interaction hooks

- AndroidX Compose `SoundEffect` / `SoundEffectOnInteraction` may provide a
  platform-level subtree hook. **Verify availability, min/compile SDK and API
  stability for the project's AndroidX version before recommending it**; do not
  assume an unstable API is a stable default.
- Platform-native interaction feedback is preferred over a custom asset for
  frequent, low-stakes actions (see the decision matrix in
  `sound-design-system.md`).

## Longer audio: MediaPlayer / Media3

- Use `MediaPlayer` or Media3 only for longer playback (a short narration, a
  completion sting with music, a notification sound). Never use them for a
  60 ms click.
- Handle audio focus, focus loss and resource release explicitly for anything
  that can play longer than a one-shot.

## Advanced audio engines are not the default

- Oboe is appropriate only for a genuine low-latency synthesis or processing
  requirement (real-time instruments, DSP). It is **not the default** for UI
  feedback and adds a native build surface.
- Do not introduce third-party runtime dependencies (sound packs, audio
  engines, animation/audio libraries) for ordinary UI cues. If a dependency is
  genuinely required, document why platform APIs are insufficient and verify
  the asset license before vendoring anything.
- Do not add an asset that you do not have a verified right to redistribute;
  record source and license in `sound-catalog-template.md`.

## Testing

- Verify the cue fires on the committed state change, not on recomposition or
  animation frames, and that it is absent when the user has muted feedback.
- Verify cancel/reverse paths are silent and that rapid repeats honor cooldown.
- Verify audio focus and release behavior with a longer cue on a real device.
