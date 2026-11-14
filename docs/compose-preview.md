# Headless Compose preview rendering (`compose_preview_render`)

`compose_preview_render` turns `@Preview` composables into PNGs without booting an
emulator. It wraps the [compose-preview](https://github.com/yschimke/compose-ai-tools)
CLI (`compose-preview show --json`), parses the manifest, verifies every PNG exists,
and returns the images inline so an agent can look at the UI it just wrote.

## Requirements

- `compose-preview` on `PATH`. `make setup` installs compose-ai-tools best-effort;
  `android_env_check` prints `compose-preview: MISSING` when it is absent.
- A Gradle project with at least one `@Preview` composable.
- A JDK/Gradle toolchain. The first render may download the Gradle distribution
  compose-preview wants (it runs its own Gradle version, not the wrapper).

## Calling it

```json
{
  "projectPath": "templates/compose-starter",
  "module": "app",
  "previewFqn": "com.example.starter.MainActivityKt.GreetingPreview",
  "inlineImages": true,
  "timeoutSec": 600
}
```

| Argument | Required | Meaning |
|---|---|---|
| `projectPath` | yes | Gradle project root (resolved to an absolute path) |
| `module` | no | Gradle module to scan, e.g. `app` or `:feature:home`; default scans the project |
| `previewFqn` | no | Exact preview id, passed to the CLI as `--id` |
| `inlineImages` | no | Embed PNGs in the response (default `true`) |
| `timeoutSec` | no | Render timeout, 1–3600 s (default 600) |

The default call renders **every** preview in the project:

```
compose_preview_render { "projectPath": "templates/compose-starter" }
```

## Output

A text summary followed by image blocks:

```
rendered 2 preview(s) in 3.4s via compose-preview show
project: /abs/path/templates/compose-starter
- com.example.starter.MainActivityKt.GreetingPreview (module: app, sha256: 1bdf48647f64)
  png: /abs/.../app/build/compose-previews/renders/GreetingPreview-a6fd142b.png (20517 bytes)
- activity__MainActivity (module: app, sha256: babc563b9c9f)
  png: /abs/.../app/build/compose-previews/renders/activity__MainActivity.png (23270 bytes)
```

PNGs stay on disk under `<module>/build/compose-previews/renders/`; the inline
images are a copy for the agent, never the only artifact.

Inline embedding is capped at **6 images** and **8 MiB per image** so a large
module cannot flood the agent context. The text summary always lists every
rendered preview; pass `inlineImages: false` to skip embedding entirely.

## Measured timing

On a 9.6 GiB Linux host with the compose-preview toolchain already installed:

| Run | Wall time |
|---|---|
| First render after Gradle distribution was cached | 10.7 s |
| Immediate repeat | 3.4 s |

A truly cold host also downloads the Gradle distribution compose-preview
selects, so budget minutes, not seconds, for the first run.

## Errors and fixes

| Response | Meaning | Fix |
|---|---|---|
| `compose-preview CLI not found … make setup` | CLI absent | `make setup`, or install compose-ai-tools manually |
| `compose-preview show failed (exit N)` | Gradle/build failure; stderr is included | Fix the compile error shown, then retry |
| `returned invalid JSON` | The CLI printed non-JSON (Gradle noise, wrapper failure) | Run the CLI by hand with `--json` and inspect |
| `reported no previews` | No `@Preview` matched | Add a preview, pass `module`, or check `previewFqn` |
| `no preview PNG was produced` | Manifest paths exist but files are missing | Re-run after a successful build; check `build/compose-previews/` |
| `inline images capped at …` | More than 6 previews rendered | Narrow with `module`/`previewFqn`, or set `inlineImages: false` |

## Notes

- Preview ids look like `com.example.starter.MainActivityKt.GreetingPreview`
  (class + function). `activity__MainActivity` is compose-preview's synthetic
  preview for an activity entry point.
- `expected/` vs `renders/`: compose-preview may keep baseline images separately;
  this tool reports the `pngPath` the CLI returns, which is the freshly rendered
  file.
- `compose_preview_render` is a **render** step, not a diff step. Use the
  screenshot-diff skill and Roborazzi goldens for regression checks.
