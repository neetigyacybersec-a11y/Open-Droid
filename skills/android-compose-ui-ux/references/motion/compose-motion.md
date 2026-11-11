# Jetpack Compose Motion — recipes

The default platform for new work. All recipes assume `MotionTokens` from `assets/MotionTokens.kt` is in the project. Read `references/timing-and-easing.md` first if you haven't — this file uses its tokens.

**Golden pattern:** Compose motion is **state-driven**. UI is a function of state; animation is a function of state *change*. You almost never "start an animation" in Compose — you declare how state maps to animation and let the framework interpolate. Event-driven `Animatable` code is the exception, reserved for one-shot feedback and gesture settling.

## Contents
1. [Single-value animation: `animate*AsState`](#1-single-value-animation)
2. [`AnimatedVisibility` — enter/exit](#2-animatedvisibility)
3. [`AnimatedContent` — swapping content](#3-animatedcontent)
4. [`updateTransition` — coordinated multi-property](#4-updatetransition)
5. [`animateContentSize` — layout size changes](#5-animatecontentsize)
6. [`Animatable` — imperative control](#6-animatable)
7. [Loops: `rememberInfiniteTransition`](#7-loops)
8. [Performance: `graphicsLayer` + `derivedStateOf`](#8-performance-pattern)
9. [Navigation transitions](#9-navigation-transitions)
10. [Shared elements / container transform (Compose 1.7+)](#10-shared-elements)
11. [Gestures: drag, swipe, bottom sheets, pull-to-refresh](#11-gestures)
12. [Predictive back](#12-predictive-back)
13. [Haptics](#13-haptics)
14. [Testing animations](#14-testing-animations)

---

## 1. Single-value animation

`animate*AsState` retargets automatically when the target changes — interruption-safe by default. This is your default tool for any state-driven change.

```kotlin
val ColorAsState: Color by animateColorAsState(
    targetValue = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
    animationSpec = tween(MotionTokens.Normal),
    label = "accent",
)

val elevation by animateDpAsState(
    targetValue = if (hovered) 8.dp else 2.dp,
    animationSpec = tween(MotionTokens.Fast),
    label = "elevation",
)
```

Available variants: `Float`, `Color`, `Dp`, `Int`, `IntOffset`, `IntSize`, `Rect`, `Offset` — plus the generic `animateValueAsState` with a custom `TwoWayConverter`.

**Rules:**
- Always set `label` — it shows in Layout Inspector's Compose pane and makes jank debugging possible.
- Tween for color/alpha state accents; `springCrisp()` for anything spatial (scale, offset) so retargets keep velocity.
- Never drive layout positioning through these (e.g., animating `padding` per frame) — animate the visual property and reserve layout changes for `animateContentSize`.

## 2. AnimatedVisibility

For appear/disappear of a subtree. Enter earns attention; exit vacates quickly (§2 of the taste model).

```kotlin
AnimatedVisibility(
    visible = expanded,
    enter = fadeIn(tween(MotionTokens.Normal, easing = MotionTokens.StandardDecelerate)) +
        expandVertically(tween(MotionTokens.Medium, easing = MotionTokens.Emphasized)),
    exit = fadeOut(tween(MotionTokens.exit(MotionTokens.Normal))) +
        shrinkVertically(tween(MotionTokens.exit(MotionTokens.Medium), easing = MotionTokens.StandardAccelerate)),
    label = "detailPanel",
) { DetailContent() }
```

Enter/exit building blocks and pairings that always look premium:

| Element shape | Enter | Exit |
| --- | --- | --- |
| Anything small (chips, rows) | `fadeIn(Normal, StandardDecelerate)` | `fadeOut(exit(Normal))` |
| Containers (panels, sections) | `fadeIn(Normal)` + `expandVertically(Medium, Emphasized)` | `fadeOut` + `shrinkVertically(exit(Medium), StandardAccelerate)` |
| Floating (menus, tooltips) | `fadeIn(Normal)` + `scaleIn(Fast, StandardDecelerate, 0.92f)` | `fadeOut(Fast)` (+ `scaleOut(Fast, StandardAccelerate, 0.94f)` optional) |
| Full screens (if not shared-element) | `fadeIn(Medium)` + slide 16–24 dp | `fadeOut(exit(Medium))` |

Directional slides:
```kotlin
slideInHorizontally(tween(MotionTokens.Medium, easing = MotionTokens.StandardDecelerate)) { full -> full / 4 }
slideInVertically(tween(MotionTokens.Medium)) { full -> -full / 6 }   // drop-in from above
```
Slide fraction ≤ 1/4 of the element's size. **RTL:** `slideInHorizontally { it }` always comes from the left. To respect layout direction:
```kotlin
val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
slideInHorizontally(...) { full -> (if (rtl) -1 else 1) * full / 4 }
```

`Modifier.animateEnterExit()` — for children inside an `AnimatedVisibility` that need their own (smaller, later) motion:
```kotlin
Column(Modifier.animateEnterExit(enter = fadeIn(tween(MotionTokens.Medium, delayMillis = 60)), exit = fadeOut(tween(MotionTokens.exit(MotionTokens.Medium)))))
```
Keep child delays ≤ 60 ms — they must feel like one choreography.

Gating replays: entrance animations must not replay on configuration change. Gate on session-scoped state:
```kotlin
val playedFirstLoad = rememberSaveable { mutableStateOf(false) }
LaunchedEffect(Unit) { if (!playedFirstLoad.value) { playedFirstLoad.value = true; /* drive entrance */ } }
```
(or drive entrance from a "content loaded" state that is naturally false→true once).

## 3. AnimatedContent

For content that swaps (counters, selected tabs' text, paged labels, image crossfades with size change).

```kotlin
AnimatedContent(
    targetState = count,
    transitionSpec = {
        val up = targetState > initialState
        if (up) {
            (slideInVertically(tween(MotionTokens.Normal, easing = MotionTokens.StandardDecelerate)) { it / 2 } + fadeIn(tween(MotionTokens.Normal))) togetherWith
                (slideOutVertically(tween(MotionTokens.Normal, easing = MotionTokens.StandardAccelerate)) { -it / 2 } + fadeOut(tween(MotionTokens.exit(MotionTokens.Normal))))
        } else {
            (slideInVertically(tween(MotionTokens.Normal, easing = MotionTokens.StandardDecelerate)) { -it / 2 } + fadeIn(tween(MotionTokens.Normal))) togetherWith
                (slideOutVertically(tween(MotionTokens.Normal, easing = MotionTokens.StandardAccelerate)) { it / 2 } + fadeOut(tween(MotionTokens.exit(MotionTokens.Normal))))
        }
    },
    label = "counter",
) { value -> Text("$value") }
```

Direction-aware detail: the direction of the slide must match the semantic direction of the change (increment = up, decrement = down; next page = start→end). This one-to-one mapping between *meaning* and *motion* is what makes content feel real.

With size change (e.g., badge text "9" → "10"):
```kotlin
transitionSpec = { ... } + SizeTransform(clip = false)   // animate container size along with content
```
Also add `Modifier.animateContentSize()` on the badge container if the text length changes.

## 4. updateTransition

When several properties must move together as one state (a pill tab that changes width, background, icon, and text color):

```kotlin
enum class FabState { Collapsed, Expanded }

val transition = updateTransition(targetState = fabState, label = "fab")
val bg by transition.animateColor(label = "bg") { state ->
    if (state == FabState.Expanded) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.primary
}
val radius by transition.animateDp(label = "radius", transitionSpec = { tween(MotionTokens.Medium, easing = MotionTokens.Emphasized) }) { state ->
    if (state == FabState.Expanded) 24.dp else 28.dp
}
val width by transition.animateDp(label = "width", transitionSpec = { MotionTokens.springSoft() }) { ... }

Surface(shape = RoundedCornerShape(radius), color = bg, modifier = Modifier.width(width)) { ... }
```

Benefits over separate `animate*AsState` calls: one transition drives all properties with the same interruption semantics, and you can inspect the whole choreography in the Layout Inspector. Prefer it whenever ≥ 2 properties share one state.

## 5. animateContentSize

The only sanctioned way to animate layout size:
```kotlin
Column(Modifier.animateContentSize(animationSpec = MotionTokens.springSoftSize(), alignment = Alignment.BottomStart)) { if (expanded) Details() }
```
- Use for expand/collapse, wrapping text growth, badges.
- `springSoftSize()` = `spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioNoBouncy)` (visibility/stiffness typed per IntSize).
- Gotcha: it animates *whatever layout changes happen inside* — keep the subtree small; a huge subtree animating size every frame = jank. If content loads async inside an auto-sized container, consider crossfading the container instead.

## 6. Animatable

Imperative, multi-step, gesture-settling, one-shot feedback. Retarget with `animateTo`; never restart-by-reset.

```kotlin
// Heart pop (the single sanctioned bounce)
val scale = remember { Animatable(1f) }
val haptics = LocalHapticFeedback.current
LaunchedEffect(liked) {
    if (liked) {
        scale.snapTo(0.75f)                                   // anticipation dip (instant)
        scale.animateTo(1.15f, tween(MotionTokens.Fast, easing = MotionTokens.StandardDecelerate))
        scale.animateTo(1f, MotionTokens.springPlayful())
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
    } else {
        scale.animateTo(1f, tween(MotionTokens.exit(MotionTokens.Fast)))
    }
}
Icon(painter, null, Modifier.graphicsLayer { scaleX = scale.value; scaleY = scale.value })
```

Pattern rules:
- `LaunchedEffect(key)` keyed on the state — cancelling previous job automatically on rapid re-trigger (rule: cancel-then-run, no fighting animations).
- `snapTo` only for pre-positioning and gesture tracking.
- Seed gesture velocity: `Animatable.animateTo(target, spring(..., visibilityThreshold = ...), initialVelocity = velocityPxPerSec)`.
- Multi-step sequences: chain `animateTo` calls in one `LaunchedEffect` (max 2 steps before it stops feeling premium).

## 7. Loops

`rememberInfiniteTransition` for loading/ambient only. Loop = calm: 1200–1600 ms cycle, small amplitude, linear or sine-feel easing.

```kotlin
val transition = rememberInfiniteTransition(label = "pulse")
val alpha by transition.animateFloat(
    initialValue = 1f, targetValue = 0.45f,
    animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
    label = "alpha",
)
SkeletonBox(Modifier.graphicsLayer { this.alpha = alpha })
```

Never loop: decorative elements, hero images, background gradients, "shine" sweeps on idle UI. If something loops while idle and isn't a progress indicator, delete it.

## 8. Performance pattern

Reading animated state in composition recomposes per frame. Read it in the **draw phase** instead:

```kotlin
val progress by animateFloatAsState(targetValue = if (done) 1f else 0f, label = "progress")

// BAD: recomposes the whole row 60x/s
Row(Modifier.graphicsLayer(alpha = progress)) { ... }          // alpha= param reads in composition

// GOOD: zero recomposition; state read during draw
Row(Modifier.graphicsLayer { this.alpha = progress }) { ... }
```

The lambda form of `graphicsLayer { }` defers the read to the draw phase. Use it for `alpha`, `scaleX/Y`, `translationX/Y`, `rotationX/Y/Z`, `shape` morphs. Combine with `derivedStateOf` when the *animation* isn't needed at all — only thresholds:
```kotlin
val collapsed by remember { derivedStateOf { listState.firstVisibleItemScrollOffset > 220 } }
// animate the header only when collapsed flips
```

Never animate: `padding`, `width/height` (except `animateContentSize`), `Arrangement` spacing, offsets that trigger layout. Animate `graphicsLayer` translation instead.

## 9. Navigation transitions

navigation-compose 2.7+ puts transitions on `NavHost`/`composable`. Shared-axis X idiom (forward = enter from end; back = reverse):

```kotlin
NavHost(
    navController, startDestination = "list",
    enterTransition = {
        slideInHorizontally(tween(MotionTokens.Medium, easing = MotionTokens.StandardDecelerate)) { it / 4 } +
        fadeIn(tween(MotionTokens.Medium))
    },
    exitTransition = { fadeOut(tween(MotionTokens.exit(MotionTokens.Medium))) },
    popEnterTransition = {
        slideInHorizontally(tween(MotionTokens.Medium, easing = MotionTokens.StandardDecelerate)) { -it / 4 } +
        fadeIn(tween(MotionTokens.Medium))
    },
    popExitTransition = {
        slideOutHorizontally(tween(MotionTokens.exit(MotionTokens.Medium), easing = MotionTokens.StandardAccelerate)) { it / 4 } +
        fadeOut(tween(MotionTokens.exit(MotionTokens.Normal)))
    },
) { /* destinations */ }
```

Per-destination overrides when a specific pair needs a container transform (see §10). Dialog destinations: keep material3 defaults (`ModalBottomSheet`, `Dialog` handle their own motion; wrap content in `AnimatedVisibility` only for inner reveals).

RTL: the `{ it / 4 }` offset is positive-left. For RTL apps mirror the sign (see §2 helper) or test both directions.

## 10. Shared elements

Compose 1.7+ (`androidx.compose.animation`) has real shared-element transitions — the premium card→detail morph. Structure:

```kotlin
SharedTransitionLayout {                                   // (A) scope with SharedTransitionScope
    NavHost(navController, "list") {
        composable("list") {
            ListScreen(
                sharedScope = this@SharedTransitionLayout,
                animatedScope = this@composable,           // AnimatedContentScope
            )
        }
        composable("detail/{id}") { entry ->
            DetailScreen(sharedScope = this@SharedTransitionLayout, animatedScope = this@composable, id = entry.arguments)
        }
    }
}

// In ListScreen — the card image carries identity:
with(sharedScope) {
    AsyncImage(
        model, null,
        Modifier
            .sharedElement(
                rememberSharedContentState(key = "image-$id"),
                animatedVisibilityScope = animatedScope,
            )
            .fillMaxWidth(),
    )
}
// In DetailScreen — same key, different size → framework morphs between them
```

Use `sharedBounds(rememberSharedContentState("container-$id"), animatedVisibilityScope = ...)` for container morphs (background/shape changes between the two states) — it also animates bounds + content crossfade.

**Rules:**
- 1 hero per transition: the image OR the card container — not both plus the title.
- Keys stable per item: `"image-$id"`, never positions/indices.
- Titles/text that exist on both screens: `sharedBounds` with `enter = fadeIn()`, `exit = fadeOut()` for a clean letter-level crossfade.
- If the detail screen loads async, give the hero a placeholder size immediately — a morph into an empty frame kills the effect.
- Works across `AnimatedContent` too (not just NavHost) with the same scopes.

## 11. Gestures

**Prime rule: the finger owns the element.** While the gesture is active, position tracks input 1:1 with zero easing. Animation starts only at release, seeded with the gesture's velocity.

**Swipe-to-dismiss (list item):**
```kotlin
val offsetX = remember { Animatable(0f) }
val scope = rememberCoroutineScope()
Row(
    Modifier
        .offset { IntOffset(offsetX.value.roundToInt(), 0) }
        .draggable(
            orientation = Orientation.Horizontal,
            state = rememberDraggableState { delta -> scope.launch { offsetX.snapTo(offsetX.value + delta) } },   // 1:1 finger
            onDragStopped = { velocity ->
                val dismissed = offsetX.value < -thresholdPx || velocity < -flingPx
                scope.launch {
                    if (dismissed) {
                        offsetX.animateTo(-fullWidthPx, MotionTokens.springSoft())        // fly out
                        onDismiss()                                                        // then remove item
                    } else {
                        offsetX.animateTo(0f, MotionTokens.springCrisp())                  // settle back
                    }
                }
            },
        ),
) { ... }
```
Consider `AnchoredDraggable` (foundation) when there are discrete states (closed / action-revealed / dismissed) — define `DraggableAnchors` and let `anchoredDraggable` handle settle springs; same finger-first semantics.

**Bottom sheet (custom):** prefer material3 `ModalBottomSheet`/`BottomSheetScaffold` — their built-in motion already follows the rules (scrim fade, spring settle, gesture follow). Custom sheets: `AnchoredDraggableState` with anchors `Collapsed(partialHeight)`, `Expanded(fullHeight)`; on release `animateTo(nearest/velocity-chosen anchor, springSoft)`; scrim alpha = `derivedStateOf` progress, tween-free (it should track the sheet 1:1).

**Pull-to-refresh:** material3 1.3+ `PullToRefreshBox(isRefreshing, onRefresh, state = rememberPullToRefreshState())` — use it. If custom: distance = `overshootFraction`-clamped drag, indicator scale/rotation tracks pull 1:1, snap to threshold with `springCrisp()`, never rubber-band past max without damping.

**Scroll-linked headers:** header shrink = `derivedStateOf { scrollOffset }` → `graphicsLayer { translationY / scaleY }`. No springs while scrolling (must feel attached to the finger); spring only the snap when the user releases mid-transition.

## 12. Predictive back

androidx.activity 1.8+ (`android:enableOnBackInvokedCallback="true"` in the manifest). The system shows the current screen shrinking toward the corner; your job: make the *previous* screen's content ready and avoid fighting the system animation.

```kotlin
val backState = rememberPullToRefreshState()   // or track PredictiveBackProgress
BackHandler { /* pre-P predictive: run your custom exit */ }
// In-app custom predictive motion:
PredictiveBackHandler { progress ->
    // progress: Flow<BackEventCompat> — screen scales 1f→0.9f, x→edge, alpha→0.8 tracking the gesture 1:1
    try {
        progress.collect { event -> swipeOffset = event.progress }
        onBack()                              // gesture committed
    } catch (e: CancellationException) {
        animateBackToRest()                   // gesture cancelled → spring back
    }
}
```
Scale floor 0.9, alpha floor 0.8 — the system's visual spec; matching it keeps your screen coherent with system chrome. Never animate screens during predictive back *other than* this shrink — extra slides/scales break the shared gesture feel.

## 13. Haptics

Motion the user feels doubles perceived quality — but only on *confirmations* and *arrivals*, not on every frame.

**Compose:**
```kotlin
val haptics = LocalHapticFeedback.current
haptics.performHapticFeedback(HapticFeedbackType.LongPress)   // strong confirm (like, delete)
haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)   // subtle tick (stepper, segment change)
```

**View constants via LocalView (richer set; check API level):**
```kotlin
val view = LocalView.current
view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)      // API 21+: subtle tick
view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)         // API 30+: success
view.performHapticFeedback(HapticFeedbackConstants.REJECT)          // API 30+: failure
view.performHapticFeedback(HapticFeedbackConstants.GESTURE_START)   // API 30+: gesture thresholds
```

Mapping: like/save → `LongPress`/`CONFIRM`; toggle on → `CONFIRM` (off: silent); threshold crossing (pull-to-refresh armed) → `GESTURE_START`/`CLOCK_TICK`; step/segment change → `TextHandleMove`/`CLOCK_TICK`; destructive done → `REJECT`. Frequency: haptic on *state change*, never continuous. Respect the user's "touch feedback" system setting — `performHapticFeedback` already does.

## 14. Testing animations

compose-ui-test can simulate the animation clock:

```kotlin
composeTestRule.mainClock.autoAdvance = false
composeTestRule.setContent { App() }
composeTestRule.onNodeWithText("Save").performClick()
composeTestRule.mainClock.advanceTimeBy(MotionTokens.Medium.toLong() + 50)
composeTestRule.waitForIdle()
composeTestRule.onNodeWithTag("result").assertIsDisplayed()
```

Also assert reduced-motion paths: wrap content with the reduced-motion `CompositionLocal` set true and assert final states render instantly (no `advanceTimeBy` needed). See `references/performance-and-accessibility.md` §6.
