# Performance & Accessibility — the non-negotiables

Motion that stutters or ignores user settings is the opposite of premium. Read this before finishing any task.

## Contents
1. [What is cheap to animate](#1-what-is-cheap-to-animate)
2. [Compose performance rules](#2-compose-performance-rules)
3. [View performance rules](#3-view-performance-rules)
4. [Measuring jank](#4-measuring-jank)
5. [Animation libraries (Lottie/Rive)](#5-animation-libraries)
6. [Reduced motion — the wiring everyone forgets](#6-reduced-motion--the-wiring-everyone-forgets)
7. [Accessibility rules](#7-accessibility-rules)

---

## 1. What is cheap to animate

The GPU-composited properties (no layout, no measure, no invalidation storms):

| System | Cheap | Expensive (never per-frame) |
| --- | --- | --- |
| Views | `translationX/Y/Z`, `scaleX/Y`, `alpha`, `rotation/X/Y`, `elevation` | `layoutParams` (width/height/margins), `padding`, `text` size, anything calling `requestLayout()` |
| Compose | `graphicsLayer { }` (alpha, scale, translation, rotation, shape), color draws in `Canvas`/draw phase | `padding`, `width()/height()`, `offset` in modifiers chain that trigger layout, recomposing whole subtrees |

Text and images: fade/scale the container, never re-layout the text per frame.

## 2. Compose performance rules

1. **Read animation state in the draw phase** — lambda `graphicsLayer { }`, not parameter `graphicsLayer(alpha = x)` (which reads in composition):
```kotlin
// recomposes per frame (bad)              // draw-phase only (good)
Modifier.graphicsLayer(alpha = a)          Modifier.graphicsLayer { this.alpha = a }
```
2. **`derivedStateOf` instead of animating everything.** If you only need a threshold ("is scrolled past X"), derive it — don't run an animation per pixel.
3. **Key anims per state, not per event.** `animate*AsState`/`updateTransition` driven by state re-target cleanly; event-launched `Animatable` jobs need `LaunchedEffect(key)` so old jobs cancel.
4. **`animateContentSize` on small subtrees.** Its cost is proportional to the content measured during the animation. Huge lists inside an auto-animating container = jank; prefer crossfading or capping height.
5. **Don't recompose shared ancestors.** Keep animated state scoped to the smallest composable that needs it (hoist animation *result* into `graphicsLayer`, not into parameters).
6. **Lists:** stable item keys, stable lambdas; entrance staggers animate item *content*, not the list's layout.
7. First frame matters too: pre-position entering elements via their *enter* animation initial values (Compose does this in `AnimatedVisibility`) — a flash of final-state before enter = "pop". If you see it, the enter spec is missing, not the duration wrong.

## 3. View performance rules

1. `ViewPropertyAnimator` + transform properties are render-thread backed on API 21+ — the safe default.
2. Multi-property, complex views: `withLayer()` (hardware layer during animation; auto-removed).
3. Cancel animators on detach (`AnimatorSet.cancel()` / `view.clearAnimation()`); never start animators from `onDraw`.
4. `ValueAnimator` update callbacks must not allocate (precompute targets, reuse `Paint`/`Rect`).
5. RecyclerView: `setHasFixedSize(true)` where valid; payload-based partial binds; item animators on (short) token durations.
6. MotionLayout: runs layout each progress tick — small scenes only; avoid nesting; avoid animating large text.

## 4. Measuring jank

Don't tune blind. Measure:

- **JankStats** (androidx.metrics): collect per-frame durations, log percentiles:
```kotlin
val listener = JankStats.addStatesToLogs(...)   // attach PerformanceMetricsState to the Activity root
jankStats.jankHeuristicPercentile = 90           // investigate frames over p90
```
- **Layout Inspector (Compose):** recomposition counts — an element recomposing every frame during a *steady* animation means you're reading animation state in composition (fix with §2.1).
- **Perfetto/Macrobenchmark** for release-level proof (frame timeline, missed vs deadline frames).
- Target: p90 frame time < 8 ms (120 Hz headroom) / < 16 ms (60 Hz); no missed vs expected deadline in the touched flows.

## 5. Animation libraries

- **Lottie / Rive**: only when files are provided or user asks. Rules still apply: set playback speed so effective duration lands on token values (`speed = 1f * intrinsic / tokenMs`), loop only progress indicators, pause when not visible (`lifecycle` observer), respect reduced motion (jump to end frame).
- Never add a motion library to solve a timing problem — tokens + platform APIs cover everything in this skill.

## 6. Reduced motion — the wiring everyone forgets

**The system setting:** Developer options → "Remove animations" (or Accessibility settings) sets `ANIMATOR_DURATION_SCALE`, `TRANSITION_ANIMATION_SCALE`, `WINDOW_ANIMATION_SCALE` to 0.

- **Views:** `ViewPropertyAnimator`, `ValueAnimator`, activity/fragment transitions respect the scale automatically → duration 0 = instant. Your job: make sure the *final state is complete* at duration 0 (no content gated behind `onAnimationEnd`-only logic).
- **Compose does NOT respect the scale.** Wire it explicitly:

```kotlin
// MotionTokens.kt provides:
val LocalReduceMotion = staticCompositionLocalOf { false }

fun Context.animatorDurationScale(): Float =
    Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

@Composable
fun MotionSettingsProvider(content: @Composable () -> Unit) {
    val context = LocalContext.current
    var reduced by remember(context) { mutableStateOf(context.animatorDurationScale() == 0f) }
    // Reactive: a system-settings change pauses/resumes the activity, so
    // re-read on ON_RESUME instead of freezing the first-composition value.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        reduced = context.animatorDurationScale() == 0f
    }
    CompositionLocalProvider(LocalReduceMotion provides reduced, content = content)
}

// Usage helper:
@Composable
fun <T> motionSpec(reduced: Boolean = LocalReduceMotion.current, normal: AnimationSpec<T>, fast: AnimationSpec<T> = snap()): AnimationSpec<T> =
    if (reduced) fast else normal
```

- Requires `androidx.lifecycle:lifecycle-runtime-compose` for `LifecycleEventEffect`.
- With reduced motion ON: enter/exit render final state instantly (`fadeIn(snap())` / drop slide components), gesture-follow still works (it's user-controlled), progress spinners still run (they're status, not decoration), skeletons may show static shapes.
- Test: toggle the developer setting, background/foreground the app, re-run every touched flow — content complete, controls reachable, no stuck invisible states.
- Also honor Web/Vestibular-style sensitivity: full-screen parallax/zoom transitions (the only places with large travel) should degrade to fades under reduced motion even when scale > 0 — gate the *travel*, not the state change.

## 7. Accessibility rules

1. **No information lives only in motion.** After every animation, the static layout must carry all meaning (selected states, errors, counts).
2. **TalkBack order & focus:** animations must not move focusable elements mid-focus. Entrances animate decoration, not the semantic tree — keep `semantics { }` stable; prefer animating `graphicsLayer`, not conditional `if` swaps that rebuild semantics.
3. **Content descriptions** never animate away (e.g., icon morph play↔pause keeps `contentDescription = "Play"/"Pause"` current at state change time, not mid-morph).
4. **Flashes:** nothing flashes > 3×/second (seizure safety). Shimmer/pulse at ≤ 1 Hz.
5. **Durations at scale 0 are instant** — verify no `onAnimationEnd`-gated logic (place content in the composition immediately, animate only its visual).
6. **Predictive back / system gestures:** never consume back to play a custom animation when system predictive-back is enabled unless you implement the scale-shrink contract.
7. **Contrast during crossfades:** mid-fade text over busy imagery can dip below contrast — crossfade backgrounds too, or fade through the surface color.
8. **Dark mode:** motion color pairs (scrims, containers, glows) come from theme tokens — a "subtle" white glow at 0.3 alpha is not subtle in dark mode; verify both modes.
9. **RTL:** directional motion mirrors (see compose-motion.md §2); test with `adb shell settings put global force_rtl 1` or a pseudo-locale.
10. **Large fonts:** elements that scale visually (press 0.97) must not clip text — scale the container with enough padding, or scale a wrapper behind text.
