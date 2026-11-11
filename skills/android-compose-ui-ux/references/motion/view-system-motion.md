# View / XML System Motion — recipes

For apps (or screens) built on the View system. Compose is the default for new work, but a premium app animates consistently across both systems — same tokens, same feel. Read `references/timing-and-easing.md` first.

**View-land mental model:** you *start* animations imperatively. That makes interruption-safety your responsibility: before starting any animation, decide what happens if the user triggers it again mid-flight. The default correct answer: cancel + retarget with a spring.

## Contents
1. [Token bridge (View ↔ MotionTokens)](#1-token-bridge)
2. [ViewPropertyAnimator — the daily tool](#2-viewpropertyanimator)
3. [ValueAnimator / ObjectAnimator / AnimatorSet](#3-valueanimator--objectanimator--atorset)
4. [dynamicanimation — real springs](#4-dynamicanimation--real-springs)
5. [Touch feedback done right](#5-touch-feedback)
6. [MotionLayout — scroll choreography](#6-motionlayout--scroll-choreography)
7. [AnimatedVectorDrawable — icon morphs](#7-animatedvectordrawable--icon-morphs)
8. [MaterialContainerTransform — fragment/activity morphs](#8-materialcontainertransform)
9. [Activity shared-element transitions](#9-activity-shared-elements)
10. [Dialogs & sheets](#10-dialogs--sheets)
11. [RecyclerView item animations](#11-recyclerview-item-animations)
12. [Legacy XML animators](#12-legacy-xml-animators)

---

## 1. Token bridge

Views have no Easing classes like Compose — build them once in `MotionTokens` (or a sibling `MotionInterpolators`):

```kotlin
object MotionInterpolators {
    val Emphasized = PathInterpolator(0.20f, 0f, 0f, 1f)          // android.view.animation, API 21+
    val EmphasizedAccelerate = PathInterpolator(0.30f, 0f, 0.80f, 0.15f)
    val EmphasizedDecelerate = PathInterpolator(0.05f, 0.70f, 0.10f, 1f)
    val StandardAccelerate = PathInterpolator(0.30f, 0f, 1f, 1f)
    val StandardDecelerate = PathInterpolator(0f, 0f, 0f, 1f)
}
```
Durations come from `MotionTokens` (`Fast=120, Normal=200, Medium=280, Slow=380, Hero=500`, `exit(d) = d*0.75`). ViewPropertyAnimator/ValueAnimator respect the system `ANIMATOR_DURATION_SCALE` automatically — one place Compose differs.

## 2. ViewPropertyAnimator

The daily tool. One fluent chain, properties run on the render thread, auto-cancels per-property:

```kotlin
// Entrance: rise + fade, emphasized settle
view.translationY = 24.dp0f                                  // pre-position before visible
view.alpha = 0f
view.animate()
    .translationY(0f).alpha(1f)
    .setDuration(MotionTokens.Medium.toLong())
    .setInterpolator(MotionInterpolators.StandardDecelerate)
    .setListener(object : AnimatorListenerAdapter() {
        override fun onAnimationEnd(a: Animator) { view.translationY = 0f }   // cleanup: no stale state
    })
```

Rules:
- Only these properties: `translationX/Y/Z`, `scaleX/Y`, `alpha`, `rotation/X/Y`. **Never** animate `layoutParams` (width/height/margins) per frame — collapse is `scaleY` + alpha or a custom measure animation.
- `withLayer()` enables a hardware layer for the duration — use it for multi-property moves of complex views; remove afterwards (it does this automatically).
- Pre-position (set start values) *before* the view becomes visible (`visibility = INVISIBLE` → set → animate), so the first frame is already correct.
- Chaining: `withEndAction { }` for one follow-up (max 2 sequential steps — after that, choreograph with `AnimatorSet` or reconsider).
- Interruption: `view.animate()` cancels the previous chain's properties automatically. For state-like values prefer springs (§4).

## 3. ValueAnimator / ObjectAnimator / AnimatorSet

For choreography (ordered/parallel steps), custom evaluation, or animating things that aren't view properties:

```kotlin
AnimatorSet().apply {
    playTogether(
        ObjectAnimator.ofFloat(card, View.SCALE_X, 0.94f, 1f),
        ObjectAnimator.ofFloat(card, View.SCALE_Y, 0.94f, 1f),
        ObjectAnimator.ofFloat(card, View.ALPHA, 0f, 1f),
    )
    duration = MotionTokens.Medium.toLong()
    interpolator = MotionInterpolators.Emphasized
    start()
}
```

- Stagger N children: one `ValueAnimator` (0f→1f, `Medium` duration) + per-child mapping in the update callback with index delay — cheaper and cancels as one unit:
```kotlin
ValueAnimator.ofFloat(0f, 1f).apply {
    duration = (MotionTokens.Medium + MotionTokens.Stagger * min(items.size, 12)).toLong()
    interpolator = MotionInterpolators.EmphasizedDecelerate
    addUpdateListener { a ->
        val t = a.animatedValue as Float
        items.forEachIndexed { i, v ->
            val local = ((t * window - i * delay) / itemDur).coerceIn(0f, 1f)   // 0..1 staggered
            v.alpha = local
            v.translationY = (1 - local) * 12.dp0f
        }
    }
    start()
}
```
- Cancel `AnimatorSet` and its children together on detach (`view.addOnAttachStateChangeListener` or lifecycle) — leaked animators on detached views are a classic memory/perf bug.
- `ObjectAnimator` needs getters/setters (or `PropertyValuesHolder.ofFloat` via `Property`). `ofArgb()` for colors.

## 4. dynamicanimation — real springs

androidx.dynamicanimation gives View-land physics springs with velocity seeding — the interruption-safe option for anything retargetable.

```kotlin
val scaleX = SpringAnimation(view, DynamicAnimation.SCALE_X, 1f).apply {
    spring = SpringForce(1f).apply {
        dampingRatio = SpringForce.DAMPING_RATIO_NO_BOUNCY      // structure: no bounce
        stiffness = SpringForce.STIFFNESS_MEDIUM                // 1500f — "crisp"
    }
    minimumVisibleChange = DynamicAnimation.MIN_VISIBLE_CHANGE_SCALE
}

// Retarget anytime — keeps velocity:
scaleX.animateToFinalPosition(0.97f)
```

Presets mapping (`SpringForce`):
| Preset | dampingRatio | stiffness |
| --- | --- | --- |
| snap | `DAMPING_RATIO_NO_BOUNCY` | `STIFFNESS_HIGH` (10_000) |
| crisp (default) | `DAMPING_RATIO_NO_BOUNCY` | `STIFFNESS_MEDIUM` (1_500) |
| soft | `DAMPING_RATIO_NO_BOUNCY` | `STIFFNESS_MEDIUM_LOW` (400) |
| playful (one bounce) | `DAMPING_RATIO_MEDIUM_BOUNCY` (0.5) | `STIFFNESS_MEDIUM` |
| gentle | `DAMPING_RATIO_LOW_BOUNCY` (0.75) | `STIFFNESS_MEDIUM_LOW` |

**Gesture settle with velocity** (the killer feature):
```kotlin
val tracker = VelocityTracker.obtain()
// onTouch: tracker.addMovement(event)
val velocity = tracker.xVelocity          // px/s
SpringAnimation(view, DynamicAnimation.TRANSLATION_X, targetPx).apply {
    spring = SpringForce(targetPx).apply { dampingRatio = SpringForce.DAMPING_RATIO_NO_BOUNCY; stiffness = SpringForce.STIFFNESS_MEDIUM_LOW }
    setStartValue(view.translationX)
    setStartVelocity(velocity)            // the gesture hands over its momentum
    start()
}
tracker.recycle()
```
Use for: swipe-to-dismiss, sheet settle, fling-to-page, drag-release. `FlingAnimation` (with `friction = 1.1f..1.8f` + `setMin/MaxValue`) for pure fling scrolling of custom elements.

## 5. Touch feedback

- **Keep the Material ripple** (`MaterialButton`, `MaterialCardView`, custom `RippleDrawable`). It's the platform's touch acknowledgment.
- Add the subtle scale on top for primary touchables only:
```kotlin
// In OnTouchListener, or better: a TouchController
val spring = SpringAnimation(view, DynamicAnimation.SCALE_X, 1f).apply { spring = SpringForce().apply { stiffness = SpringForce.STIFFNESS_MEDIUM; dampingRatio = SpringForce.DAMPING_RATIO_NO_BOUNCY } }
val springY = SpringAnimation(view, DynamicAnimation.SCALE_Y, 1f).apply { /* same */ }
// ACTION_DOWN: spring.animateToFinalPosition(0.97f)  — springs handle the mid-press release gracefully
// ACTION_UP/CANCEL: spring.animateToFinalPosition(1f)
```
- Apply to: primary CTA, FAB, media cards, list rows with images. Do **not** apply to every trivial text row — hierarchy.
- StateListAnimator for elevation-on-press (card lift): `android:stateListAnimator="@animator/raise"` with 120 ms duration.

## 6. MotionLayout — scroll choreography

MotionLayout (constraintlayout 2.x) interpolates between `ConstraintSet`s — use it for scroll-linked choreography (collapsing toolbars, LOTTIE-free hero headers). Don't use it for plain screen transitions (Nav/Fragment transitions do that) or new Compose screens.

Minimal collapsible header:
```xml
<!-- res/xml/scene_header.xml -->
<MotionScene xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto">

    <ConstraintSet android:id="@+id/expanded">
        <Constraint android:id="@+id/header"
            android:layout_width="0dp" android:layout_height="220dp"
            app:layout_constraintTop_toTopOf="parent" app:layout_constraintStart_toStartOf="parent"
            app:layout_constraintEnd_toEndOf="parent">
            <CustomAttribute app:attributeName="cornerRadius" app:customFloatValue="0"/>
        </Constraint>
        <Constraint android:id="@+id/title"
            android:layout_width="wrap_content" android:layout_height="wrap_content"
            android:scaleX="1.2" android:scaleY="1.2"
            app:layout_constraintBottom_toBottomOf="@id/header" app:layout_constraintStart_toStartOf="parent"
            android:layout_marginStart="24dp"/>
    </ConstraintSet>

    <ConstraintSet android:id="@+id/collapsed">
        <Constraint android:id="@+id/header"
            android:layout_width="0dp" android:layout_height="64dp" ... >
            <CustomAttribute app:attributeName="cornerRadius" app:customFloatValue="28"/>
        </Constraint>
        <Constraint android:id="@+id/title" android:scaleX="0.9" android:scaleY="0.9"
            app:layout_constraintTop_toTopOf="@id/header" ... />
    </ConstraintSet>

    <Transition app:constraintSetStart="@id/expanded" app:constraintSetEnd="@id/collapsed"
        app:duration="1" app:motionInterpolator="decelerate">
        <OnSwipe app:touchAnchorId="@id/list" app:dragDirection="dragUp"
            app:touchAnchorSide="top" app:maxAcceleration="5"/>
    </Transition>
</MotionScene>
```
```xml
<androidx.constraintlayout.motion.widget.MotionLayout
    android:layout_width="match_parent" android:layout_height="match_parent"
    app:layoutDescription="@xml/scene_header"
    app:currentState="@id/expanded">
    <!-- header, title, RecyclerView -->
</androidx.constraintlayout.motion.widget.MotionLayout>
```

Key facts:
- `app:duration="1"` when driven by `OnSwipe` — the gesture owns time; duration matters only for programmatic `transitionToEnd()`.
- Keyframes: `<KeyPosition app:percentWidth/percentHeight ...>` for curved paths; `<KeyAttribute app:framePosition="50" android:alpha="0.6">` for mid-transition attribute changes; `<KeyCycle>` for a controlled single wave (e.g., subtle bob) — set `app:waveShape="sine"` and 1 cycle, not oscillation.
- `motionInterpolator` accepts `decelerate|accelerate|linear|overshoot|spring` — prefer matching MotionInterpolators via `PathInterpolator` in code-driven transitions.
- Debug: `app:motionDebug="SHOW_ALL"` (paths + positions) during development — remove before shipping.
- Perf: MotionLayout runs on every layout pass for progress updates — keep the scene's view count small; don't nest MotionLayouts.

## 7. AnimatedVectorDrawable — icon morphs

For 2-path icon morphs (menu↔arrow, play↔pause, hamburger↔X). Rules: paths must have the **same number and order of path commands** to interpolate.

```xml
<!-- res/drawable/ic_play_to_pause.xml -->
<animated-vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt">
    <aapt:attr name="android:drawable">
        <vector android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
            <path android:name="glyph" android:fillColor="?attr/colorControlNormal"
                android:pathData="M8,5 L8,19 L19,12 Z"/>
        </vector>
    </aapt:attr>
    <target android:name="glyph">
        <aapt:attr name="android:animation">
            <objectAnimator android:duration="120"
                android:propertyName="pathData"
                android:valueFrom="M8,5 L8,19 L19,12 Z"
                android:valueTo="M7,5 L17,5 L17,19 L7,19 Z M17,5 ... (pause bars as two subpaths with matching commands)"
                android:interpolator="@android:interpolator/fast_out_slow_in"/>
        </aapt:attr>
    </target>
</animated-vector>
```
Trigger: `iv.setImageState(...)` won't replay; use `AnimatedVectorDrawableCompat`/`AnimatedVectorDrawable` + `(drawable as Animatable).start()` on state change, or `AnimatedImageDrawable`... For toggles, build both directions (A→B and B→A) or reverse via `reverse()` (API 26+).

Complex icons (3+ subpaths, groups): prefer `ImageVector` + Compose, or split groups so each `<group>` translates/rotates instead of morphing path data. Trim-path ("drawing" effect) is the premium trick for line icons: animate `trimPathEnd` 0→1 over `Fast`.

## 8. MaterialContainerTransform

MDC (com.google.android.material) morph between fragments/activities/views — the View-land container transform. FAB → detail:

```kotlin
// DetailFragment — the destination declares the morph
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    sharedElementEnterTransition = MaterialContainerTransform().apply {
        drawingViewId = R.id.nav_host
        duration = MotionTokens.Hero.toLong()               // 500 — the one hero
        scrimColor = Color.TRANSPARENT
        setAllContainerColors(MaterialTheme.colorScheme.surface)
        fadeMode = MaterialContainerTransform.FADE_MODE_IN
        interpolator = MotionInterpolators.Emphasized
    }
}
```
```kotlin
// In list: button + destination view share transitionName
fab.transitionName = "card-$id"
findNavController().navigate(R.id.detail, bundleOf("id" to id),
    FragmentNavigator.Extras.Builder().addSharedElement(fab, "card-$id").build())
```
Rules: `duration = Hero (500)`; container color = themed surface (never hardcoded white — dark mode); only one shared element per navigation; entering content inside the container should stagger-fade in after the morph lands (`postDelayed` ≈ 60% of duration, fade 200 ms).

## 9. Activity shared elements

When navigation crosses activities:
```kotlin
val options = ActivityOptions.makeSceneTransitionAnimation(activity, Pair(imageView, "image-$id"))
activity.startActivity(intent, options.toBundle())
// DetailActivity:
window.sharedElementEnterTransition = ChangeBounds().apply { duration = MotionTokens.Hero.toLong(); interpolator = MotionInterpolators.Emphasized }
window.enterTransition = Fade(Fade.IN).apply { duration = MotionTokens.Medium.toLong() }   // supporting content
window.allowEnterTransitionOverlap = true     // content fades while hero moves — feels one beat shorter
```
Set `android:transitionName` in XML or `View.setTransitionName()`. Use `TransitionManager.beginDelayedTransition(container, ChangeBounds().setDuration(...).setInterpolator(...))` for in-layout reflows (view visibility/position changes) — one line, big polish.

## 10. Dialogs & sheets

- Prefer `BottomSheetDialogFragment`/`ModalBottomSheet` defaults — they implement the correct scrim fade + spring settle already.
- Custom dialogs: use a window animation style instead of code:
```xml
<style name="AppDialogAnimation" parent="Animation.AppCompat.Dialog">
    <item name="android:windowEnterAnimation">@anim/dialog_in</item>   <!-- fade+scale(0.92→1, 200ms, decelerate) -->
    <item name="android:windowExitAnimation">@anim/dialog_out</item>  <!-- fade, 150ms, accelerate -->
</style>
```
```kotlin
dialog.window?.setWindowAnimations(R.style.AppDialogAnimation)
```
- In-content reveals inside dialogs (list appearing after load): AnimatedVisibility-style pattern with ValueAnimator fade+rise.

## 11. RecyclerView item animations

- Use `DefaultItemAnimator` with tuned durations:
```kotlin
(recyclerView.itemAnimator as DefaultItemAnimator).apply {
    addDuration = MotionTokens.Medium.toLong()
    removeDuration = MotionTokens.exit(MotionTokens.Medium).toLong()
    moveDuration = MotionTokens.Medium.toLong()
    changeDuration = MotionTokens.Normal.toLong()
    supportsChangeAnimations = true
}
```
- First-load stagger: don't fight the ItemAnimator — instead, animate each item's content view on first bind (fade+rise 12 dp, `delay = Stagger * adapterPosition`, capped), gated by a `wasInitialLoad` flag in the adapter.
- Swipe dismiss: ItemTouchHelper with `onChildDraw` translation 1:1; on release, spring (`dynamicanimation`) or let the default settle; removal animates via `notifyItemRemoved` → `removeDuration`.

## 12. Legacy XML animators

Old code with `res/anim/*.xml` (`<tween>` with `android:interpolator`): migrate durations/interpolators to token values when touching the file, but don't refactor wholesale — consistency of *feel* matters more than the mechanism. New XML animation resources should reference `@integer/motion_duration_medium` style resources if the project uses them.
