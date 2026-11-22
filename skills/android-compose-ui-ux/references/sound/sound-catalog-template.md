# Sound catalog template

Copy this table into the project's design doc when custom sound is included.
It is the provenance record: an asset without a verified source and license is
not shipped.

| Token | Semantic event | Asset file | Source | License | Attribution | Gain | Duration | Priority | Cooldown |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `confirm` | Save completed (user-initiated) | `res/raw/confirm.ogg` | `<source URL or original work>` | `<license + version>` | `<creator / link, or "none required">` | 0.16 | 120 ms | high | 350 ms |
| `reject` | Correctable validation failure | `res/raw/reject.ogg` | `<source URL or original work>` | `<license + version>` | `<creator / link, or "none required">` | 0.14 | 100 ms | highest | 300 ms |

## Rules

- One row per token role from `sound-tokens.md`. Empty cells mean "not decided",
  not "allowed".
- `Source` and `License` are required for vendored or imported audio. CC0 needs
  no attribution, but crediting the creator is still good practice.
- Custom-created assets: set `Source` to the project and `License` to the
  project's license; do not leave the fields blank.
- Remove a row if the product decides the event should be silent — silence is a
  valid catalog entry, represented by omitting the asset.
- Keep this file next to `MotionTokens.kt` so motion and sound review happen in
  the same pass.
