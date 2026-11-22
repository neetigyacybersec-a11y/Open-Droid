# Interaction evidence record

One small record per tested flow, written **alongside** the existing capture
archive and baseline metadata from `screenshot_baseline_save` /
`screenshot_baseline_list`. This file is a review artifact, not a new data
store: capture files stay in the captures archive, and visual comparisons stay
with the screenshot-diff pipeline. The record only adds the context needed to
reproduce a motion / haptic / sound judgement.

Write it as JSON when a tool will read it, or Markdown when a human will — the
field set is the same. Keep the original captures; never overwrite them with a
"cleaned up" version.

## Schema

| Field | Location | Meaning |
| --- | --- | --- |
| `schemaVersion` | root | Record format version (start at `1`). |
| `timestamp` | root | When the pass ran (ISO-8601). |
| `package` | `app` | Application id under test. |
| `variant` | `app` | Build variant (`debug`, `release`, ...). |
| `version` | `app` | App version name, if available. |
| `commit` | `app` | Source commit / build sha, if available. |
| `deviceId` | `device` | Emulator or physical device serial. |
| `apiLevel` | `device` | Android API level. |
| `resolution` | `device` | Pixel resolution (e.g. `1080x2400`). |
| `density` | `device` | Display density (e.g. `440dpi`). |
| `flow` | `flow` | Flow / interaction name. |
| `actions` | `flow` | Ordered actions executed, verbatim enough to replay. |
| `frame` | `flow` | Frame index / timestamp for the key observation, when known. |
| `recording` | `artifacts` | Path to the screen recording in the capture archive. |
| `screenshot` | `artifacts` | Path to the still(s) in the capture archive. |
| `baseline` | `artifacts` | Named baseline compared against, if any (from `screenshot_baseline_list`). |
| `reducedMotion` | `settings` | On/off + how it was set. |
| `audioPreference` | `settings` | In-app sound preference state (enabled / disabled / not applicable). |
| `hapticPreference` | `settings` | System/in-app haptic setting state. |
| `motionChecks` | checks | Array of motion checks with id, status and note. |
| `soundPolicy` | checks | `used` or `not-used` — was custom sound in scope? |
| `cueIds` | checks | Semantic sound cue ids observed, if sound was used. |
| `hapticPolicy` | checks | `used` or `not-used`. |
| `eventIds` | checks | Semantic haptic event ids observed, if haptics were used. |
| `defects` | findings | Observed defects with id, severity, frame/timestamp and evidence link. |
| `severity` | findings | Per defect: `blocker`, `major`, `minor`, `nit`. |
| `skipped` | findings | Checks not run with status and reason. |

## Status vocabulary

Use exactly one status per check — never collapse them into "pass":

- `verified` — observed on the described device/settings; evidence linked.
- `failed` — observed and did not meet the contract; defect linked.
- `skipped` — intentionally not run; reason recorded (e.g. feature out of scope).
- `unavailable` — capability missing (no loopback, no haptic hardware, no
  device). **Unavailable is not a pass.**
- `not-applicable` — the flow has no such feedback by design; state why.

## Example

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-11-22T12:00:00Z",
  "app": {
    "package": "com.example.notes",
    "variant": "debug",
    "version": "1.4.0",
    "commit": "545b98a"
  },
  "device": {
    "deviceId": "emulator-5554",
    "apiLevel": 35,
    "resolution": "1080x2400",
    "density": "440dpi"
  },
  "flow": {
    "name": "save_note_confirmation",
    "actions": ["edit note", "double-tap Save", "observe committed state"],
    "frame": 142
  },
  "artifacts": {
    "recording": "~/.android-mcp/captures/screenrecord-emulator-5554-...mp4",
    "screenshot": "~/.android-mcp/captures/screenshot-emulator-5554-...png",
    "baseline": "notes-saved-state"
  },
  "settings": {
    "reducedMotion": "off",
    "audioPreference": "enabled",
    "hapticPreference": "system default"
  },
  "motionChecks": [
    { "id": "rapid-double-tap", "status": "verified", "note": "one commit, no double-run" },
    { "id": "reduced-motion", "status": "not-applicable", "reason": "second pass run separately" }
  ],
  "soundPolicy": "used",
  "cueIds": ["confirm.save"],
  "hapticPolicy": "used",
  "eventIds": ["save.committed"],
  "defects": [
    {
      "id": "D-01",
      "severity": "minor",
      "frame": 142,
      "timestamp": "2026-11-22T12:00:06Z",
      "evidence": "screenshot path above; cue overlapped second tap"
    }
  ],
  "skipped": [
    { "check": "audio.waveform", "status": "unavailable", "reason": "no loopback/capture path" }
  ]
}
```

See `deterministic-scenarios.md` for what to execute and
`verification-discipline.md` for how to word the conclusion.
