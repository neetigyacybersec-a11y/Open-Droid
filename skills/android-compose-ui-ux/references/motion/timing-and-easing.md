# Timing & Easing — the physics of premium

Read this before choosing any duration, easing curve, or spring. Every value here is chosen for perceived quality, not symmetry: the difference between 280 ms and 320 ms is audible in the user's hands even if they can't name it.

## Contents
1. [How long things should feel](#1-how-long-things-should-feel)
2. [Duration tokens](#2-duration-tokens)
3. [Easing curves — Material 3 set](#3-easing-curves--material-3-set)
4. [Spring presets](#4-spring-presets)
5. [Spring vs tween — decision rule](#5-spring-vs-tween--decision-rule)
6. [Stagger math](#6-stagger-math)
7. [Interruption & retargeting rules](#7-interruption--retargeting-rules)

---

## 1. How long things should feel

Perception research (and Material's own guidance) gives us landmarks:

| Duration | Perception |
| --- | --- |
| ≤ 100 ms | Feels **instant** — a property change, not an animation. Good for color fades on state. |
| 120–180 ms | "The app heard me." Press feedback, icon morphs, small fades. |
| 200–300 ms | Clearly animated but snappy. The workhorse range for state changes. |
| 300–400 ms | Purposeful movement of containers, screens, shared elements. Still crisp. |
| 500 ms | The ceiling for any **hero** container-transform. Only with emphasized easing. |
| > 500 ms | Reserved for gesture-driven motion (the user controls time) or dramatic one-off moments. Regular UI in this range feels sluggish. |

Rule of thumb: **exits are 25–40% faster than entrances**. Entering content earns attention (decelerate, linger slightly); exiting content must vacate quickly so the destination owns the stage.

## 2. Duration tokens

Use these names in `MotionTokens`. They map onto Material 3 duration tokens (short4 = 200, medium4 = 400, etc.) with friendlier names.

| Token | ms | Use for |
| --- | --- | --- |
| `Fast` | 120 | Press/release feedback, icon morphs, chevron flips, checkbox draw |
| `Normal` | 200 | Fades, color/alpha changes, small expand/shrink, content swaps |
| `Medium` | 280 | Standard element transitions: cards, panels, tab indicators, bottom bars |
| `Slow` | 380 | Large surfaces, screens without shared elements, bottom sheets settling |
| `Hero` | 500 | Container transform / shared element morph (the one hero) |
| `Stagger` | 18 | Per-item delay in lists (12–30 ms allowed; never longer) |

Exit helper: `exit(d) = round(d * 0.75)` floored at 90 ms → `exit(Fast)=90, exit(Normal)=150, exit(Medium)=210, exit(Slow)=285→280, exit(Hero)=375`.

Loop cadence (indeterminate progress, skeleton pulse): full cycle 1200–1600 ms, `LinearEasing` or very soft sine; amplitude small (opacity 1.0→0.45 or translation ±12 % of element size).

## 3. Easing curves — Material 3 set

These five curves cover 100% of UI work. All values are `cubic-bezier(x1, y1, x2, y2)`.

| Token | Bezier | Character | Use |
| --- | --- | --- | --- |
| `Emphasized` | (0.20, 0.00, 0.00, 1.00) | Fast start, long graceful settle | The default for hero/enter of large elements; M3's signature curve |
| `EmphasizedAccelerate` | (0.30, 0.00, 0.80, 0.15) | Rockets out, cuts short | Exits of emphasized elements |
| `EmphasizedDecelerate` | (0.05, 0.70, 0.10, 1.00) | Gentle arrival, strong settle | Enters that must feel "set down softly" |
| `StandardAccelerate` | (0.30, 0.00, 1.00, 1.00) | Clean acceleration | Exits of ordinary elements |
| `StandardDecelerate` | (0.00, 0.00, 0.00, 1.00) | Immediate response, decaying tail | Enters of ordinary elements, slides triggered by taps |

Legacy but still everywhere: `FastOutSlowIn` = (0.40, 0.00, 0.20, 1.00) — Compose's built-in `FastOutSlowInEasing`, Views' `FastOutSlowInInterpolator`. Acceptable default in View land; prefer the M3 set in Compose.

**Kotlin (Compose):**
```kotlin
val Emphasized = CubicBezierEasing(0.20f, 0f, 0f, 1f)
val EmphasizedAccelerate = CubicBezierEasing(0.30f, 0f, 0.80f, 0.15f)
val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.70f, 0.10f, 1f)
val StandardAccelerate = CubicBezierEasing(0.30f, 0f, 1f, 1f)
val StandardDecelerate = CubicBezierEasing(0f, 0f, 0f, 1f)
```

**Kotlin (Views):**
```kotlin
val Emphasized = PathInterpolator(0.20f, 0f, 0f, 1f)   // android.view.animation.PathInterpolator, API 21+
```
androidx.interpolator equivalents (when PathInterpolator is unavailable): `FastOutSlowInInterpolator`, `LinearOutSlowInInterpolator` (≈ StandardDecelerate), `FastOutLinearInInterpolator` (≈ StandardAccelerate).

**Never:** linear for enter/exit; overshoot interpolators (OvershootInterpolator/AnticipateOvershootInterpolator) — their bounce is uncontrolled; if you want bounce, use a spring where overshoot is physically damped.

## 4. Spring presets

Springs are defined by **damping ratio** (0 = no damping/wild oscillation, 1 = critically damped/no bounce) and **stiffness** (low = slow and floaty, high = fast and stiff).

| Preset | dampingRatio | stiffness | Feels like | Use |
| --- | --- | --- | --- | --- |
| `springSnap()` | NoBouncy (1f) | High (10_000f) | Mechanical click | Tiny snaps: thumb into switch rail, indicator landing |
| `springCrisp()` | NoBouncy (1f) | Medium (1_500f) | Confident, immediate | **Default** for state changes, press scale, retargeting |
| `springSoft()` | NoBouncy (1f) | MediumLow (400f) | Smooth, weighty | Large elements: sheets, containers, screens |
| `springPlayful()` | MediumBouncy (0.5f) | Medium (1_500f) | One clear overshoot | Like/save pop, badge arrival, success check |
| `springGentle()` | LowBouncy (0.75f) | MediumLow (400f) | Soft organic settle | Playful chips, drag release settle |
| fling decay | — | — | — | Fling gestures: `exponentialDecay(frictionX = 1.8f)` default is fine |

**Kotlin (Compose):**
```kotlin
fun <T> springSnap() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessHigh)
fun <T> springCrisp() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMedium)
fun <T> springSoft() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)
fun <T> springPlayful() = spring<T>(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium)
fun <T> springGentle() = spring<T>(dampingRatio = Spring.DampingRatioLowBouncy, stiffness = Spring.StiffnessMediumLow)
```

Sanity check for bounce: `MediumBouncy` overshoots ~10–12% of travel once. That's the whole allowance. If an animation visibly wobbles twice, damping is too low — raise it.

**Views (dynamicanimation):**
```kotlin
SpringAnimation(view, DynamicAnimation.SCALE_X, 1f).apply {
    spring = SpringForce().apply {
        dampingRatio = SpringForce.DAMPING_RATIO_NO_BOUNCY   // or 0.5f for playful
        stiffness = SpringForce.STIFFNESS_MEDIUM             // 1500f
    }
}
```

## 5. Spring vs tween — decision rule

Choose **spring** when any of these is true:
- The animated value can change again **while animating** (expand/collapse toggled twice, selection changes quickly, theme flips).
- The motion is **gesture-driven** (velocity on release must feed the animation).
- The element **follows the finger** then settles (swipe, drag, pull-to-refresh).

Choose **tween** (duration + easing) when:
- The motion is a **deterministic choreography** step (screen transition, entrance stagger) where the exact duration matters for rhythm.
- The animation is an **exit** (you want it gone in a known time).
- You're animating a **loop** (durations define cadence).

Rhythm needs known durations; physics needs springs. When a transition needs both (hero morph that can be interrupted), use spring with high stiffness — perceptually equivalent to a 300 ms tween but interruption-proof.

## 6. Stagger math

Stagger sells hierarchy. Rules that always look right:

- **List/grid first load:** 12–30 ms per item. Use 18 ms. Distance 12 dp rise + fade. Only on first reveal — never on back-navigation.
- **Cards/panels (3–5 elements):** 30–50 ms per element.
- **Total entrance window** (first item start → last item settle): ≤ 350 ms. If the stagger alone exceeds this, shorten per-item duration instead of cramming.
- Stagger direction follows reading order (start→end, top→bottom). In RTL it mirrors automatically if you derive order from layout position, not index.
- Supporting elements that would make the window too long should skip the stagger and just fade at `exit(Normal)`.

Compose implementation pattern (index-based delay):
```kotlin
delay = MotionTokens.Stagger * index.coerceAtMost(12)   // cap tail; late items animate together
```

## 7. Interruption & retargeting rules

Premium apps are defined by what happens when the user is faster than the animation.

1. **Prefer `animate*AsState`** — it retargets the running animation to the new target automatically, keeping current velocity (value animation) — this is the default tool.
2. **`Animatable`** for multi-property or imperative control: always call `animateTo(newTarget, newSpec)` — it retargets mid-flight. Never `snapTo` to reset and restart (visible jump). `snapTo` is only for gesture tracking (1:1 finger follow) and pre-positioning before a quick `animateTo`.
3. **Gesture-driven**: while dragging, position = finger (no animation). On release, `animateTo` the nearest anchor with a spring, seeding velocity from the gesture (`initialVelocity`).
4. **Cancellation**: launching a new `Animatable` job per event? Cancel the previous job in the same `LaunchedEffect` scope to avoid two animations fighting (classic stutter bug).
5. **Screen transitions** must survive fast double-taps on navigation: nav-graph transitions handle this; custom `AnimatedContent` must key on state, not events.
