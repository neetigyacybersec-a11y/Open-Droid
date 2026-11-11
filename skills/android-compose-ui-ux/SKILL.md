---
name: android-compose-ui-ux
description: Build high-end Jetpack Compose UI with Material 3, motion design, accessibility, adaptive layouts, design tokens, and foundations. Use whenever the user mentions animations, transitions, screen or navigation transitions, micro-interactions, motion design, spring or tween animations, Compose animation APIs (animate*AsState, AnimatedVisibility, AnimatedContent, SharedTransitionLayout / shared element), MotionLayout, ViewPropertyAnimator, AnimatedVectorDrawable, bottom sheet or FAB motion, press feedback, ripple, loading states, skeletons, splash or onboarding, pull-to-refresh, predictive back, haptics tied to motion, or says the app "feels sluggish", "laggy", "not smooth", "cheap", "basic", or "needs polish". Covers Material 3 timing and easing tokens, interruption-safe springs, 60–120 fps motion performance, and reduced-motion accessibility. Use this skill even for small touches like a button press animation or a counter change.
license: MIT
compatibility: opencode
metadata:
  audience: android-developers
  stack: compose
---
## What I do
- Guide Compose + Material 3 implementation for premium UI.
- Cover typography, color roles, motion, haptics, edge-to-edge, adaptive layouts, large screens.
- Enforce recomposition hygiene, LazyColumn keys/contentType, animation APIs.

## Consolidated capabilities (merged from android-material3-design, motion-design, uiux-design-foundations, android-adaptive-layouts)

### Material 3 tokens
- Map M3 color roles to MaterialTheme.colorScheme.* (never hardcode hex for text/surfaces).
- Use the M3 type scale tokens (display/headline/title/body/label x S/M/L + emphasized).
- Apply 8dp spacing grid and shape tokens (none/XS/S/M/L/XL/full).
- Verify dark + light themes and dynamic color fallback.
- Check contrast >= 4.5:1 (normal) / >= 3:1 (large) text.
- Anti-patterns: hardcoded colors/sizes; M2 components; ignoring dynamic color; text in dp instead of sp.

### Motion
- Use M3 motion schemes (standard/expressive) and spring tokens.
- Apply transitions: container transform, shared axis, fade through, fade.
- Keep durations 100-500ms; respect reduced motion.
- Ensure motion is functional (orient, confirm, connect).
- Anti-patterns: decorative-only motion; arbitrary easing; blocking input; ignoring accessibility.
- Deep layer: the full motion operating system lives in [Motion design system (deep layer)](#motion-design-system-deep-layer) below.

## Motion design system (deep layer)

This is the senior-motion-designer operating system, integrated from the vendored
`motion-designer` skill (FR-S1 / BACKLOG §3.8). The light rules above and the Motion laws in the
Design bar below set the bar; this section is the execution system. The `references/motion/`
directory is the deep knowledge — read references on demand, do not guess timings, curves, or
API signatures from memory.

### The taste model — six principles

Every animation must satisfy at least one; if it satisfies none, delete it.

1. **Purpose** — motion answers exactly one of five questions: Where did this come from? (enter),
   Where did it go? (exit), What changed? (state), How is this connected? (continuity),
   Did the system hear me? (feedback). Name the question before writing code; an animation that
   answers none of them is decoration, and decoration reads as cheap.
2. **Restraint** — one hero animation per screen transition; everything else is supporting cast
   (faster, shorter, fading). Small distances: 8–24 dp translations, 0.96–1.02 scale. Few
   properties: opacity + transform. Competing animations get staggered, never equal-weight.
3. **Physics** — decelerate into place, accelerate out (exits 25–40% quicker). Springs for
   anything interruptible; no bounce for structure and navigation (one playful bounce per
   screen, max). Linear easing is for loops only.
4. **Continuity** — state changes are transformations, not swaps. An element on both sides of a
   transition carries through (shared element / container transform).
5. **Hierarchy** — entering content is slower and emphasized; exiting content is faster and
   usually a quick fade. The user's finger outranks everything: gestures track 1:1; springs
   take over on release.
6. **Calm** — total choreography under ~600 ms; nothing flashes > 3×/s; nothing bounces twice;
   after 500 ms the UI is still unless a gesture is active.

### Non-negotiables (hard rules)

1. **Tokens only.** All durations, easings, springs come from a single `MotionTokens` object
   (template: `references/motion/MotionTokens.kt`). Never hardcode `300` or
   `FastOutSlowInEasing()` inline. No tokens file → create one from the template first.
2. **Structural motion ≤ 400 ms.** Navigation/containers/sheets 240–400 ms; only a full
   container-transform hero may reach 500 ms; longer must be gesture-driven.
3. **One hero.** Per screen change, exactly one emphasized element; supporting elements fade or
   slide ≤ 24 dp.
4. **Animate cheap properties only.** `translationX/Y/Z`, `scaleX/Y`, `alpha`, `rotation`
   (Views); state read inside `graphicsLayer { }` (Compose). Never animate layout size/position
   per frame by hand — `animateContentSize()` or a wrapper's `graphicsLayer`.
5. **Reduced motion.** Respect `ANIMATOR_DURATION_SCALE == 0` and "Remove animations". Views
   respect it automatically; **Compose does not** — wire the helper from `MotionTokens.kt`.
6. **Interruption-safe.** Anything interruptible mid-flight must be retargetable:
   `animate*AsState`, `Animatable.animateTo` (not snap-then-restart), springs for gestures.
7. **Exits are faster than entrances.** Enter 280 ms → exit ~200 ms; exits mostly fade.
8. **No blocking.** Input stays enabled during animations; ≤ 2 sequential animations per event.
9. **RTL-aware.** start/end semantics; `slideInHorizontally { it }` always comes from the left —
   negate offsets or use direction-aware helpers when `LayoutDirection` is RTL.
10. **No new motion dependencies without asking.** Lottie/Rive only when the user provides the
    files or asks. Everything here ships zero-dependency.

### Workflow

1. **Understand** — read the screen code; list the states. Premium motion is state-driven
   ("state A → state B"), never fire-and-forget (one-shot feedback like a like-pop excepted).
2. **Plan in one sentence** — e.g. "Card list: staggered fade+rise entrance (18 ms/item, once),
   card→detail as shared-element container transform, everything else instant." More than 3
   distinct motions requested → propose cutting to the 3 most valuable.
3. **Tokens** — find or create `MotionTokens`; choose values from `references/motion/timing-and-easing.md`. Don't invent numbers.
4. **Implement** — open the matching reference (below) and base work on its recipes; name
   things after purpose (`animateInToDetail`), not effect (`animation1`).
5. **Polish** — run `references/motion/review-checklist.md` end to end; hunt: too-long
   durations, double-bounce, simultaneous equal animations, missing retargets, leftover magic
   numbers, animations firing on rotation/first composition.
6. **Verify** — build, run the flows touched, then enable Developer options → Remove animations
   and re-run: every screen reaches its final state instantly. Perf: no per-frame recomposition
   of large subtrees; if jank is reported, measure with JankStats before tuning.

### Platform routing

| Situation | Route | Read |
| --- | --- | --- |
| New screen or Compose present | Jetpack Compose (default) | `references/motion/compose-motion.md` |
| View/XML, simple feedback & transitions | ViewPropertyAnimator + dynamicanimation | `references/motion/view-system-motion.md` |
| View/XML, scroll-linked choreography | MotionLayout (only if already in deps) | `references/motion/view-system-motion.md` §6 |
| Fragment/Activity morphs in View apps | MaterialContainerTransform | `references/motion/view-system-motion.md` §8 |
| Complex icon morphs | AnimatedVectorDrawable | `references/motion/view-system-motion.md` §7 |
| Lottie/Rive files provided | Integrate, timing still follows tokens | `references/motion/performance-and-accessibility.md` §5 |
| Mixed app | Same tokens across both systems | both files |

### Micro-interaction decision table

| User intent | Pattern | Spec |
| --- | --- | --- |
| Button/row/icon press | Scale 0.97 + ripple | catalog §1 |
| Toggle, checkbox, switch, chip select | Thumb spring + track color fade | catalog §2 |
| Like / save / bookmark / follow | Spring pop (one bounce) + haptic | catalog §3 |
| Expand/collapse, accordion, "more" | `animateContentSize` or `updateTransition` + chevron 180° | catalog §4 |
| List first load | Staggered fade + rise, 12–16 dp, once | catalog §5 |
| List insert / remove / swipe dismiss | Follow finger → spring out + collapse | catalog §6 |
| Bottom sheet, side sheet, dialog | Anchored spring + scrim fade | catalog §7 |
| FAB ↔ toolbar/screen morph | Container transform | catalog §8 |
| Screen → screen | Shared axis X / container transform | catalog §9 |
| Loading content | Skeleton pulse or spinner | catalog §10 |
| Counter, badge, tab text | Vertical slide swap | catalog §11 |
| Empty → content, error → retry | Crossfade + rise | catalog §12 |
| Cold start → home | Logo scale-in 180 ms, no progress theater | catalog §13 |
| Pull-to-refresh, scroll-linked header | Gesture 1:1 + spring settle | catalog §14 |

Full specs: `references/motion/micro-interactions-catalog.md`.

### Quick recipes — the 80% cases

Press feedback (every touchable, scale 0.97 + spring via `MutableInteractionSource` +
`graphicsLayer`), enter/exit (`AnimatedVisibility`: fade + gentle decelerate-grow in, quicker
fade + accelerate-shrink out), value changes (`AnimatedContent` vertical slide swap),
size growth (`animateContentSize`), like-pop (snap 0.8 → spring to 1 + haptic, the one bounce
allowed), nav transitions (shared-axis `NavHost` enter/exit/pop pairs). Copy-ready code for all
six lives in `references/motion/compose-motion.md` and the hub SKILL.md history; do not
re-derive them.

### Common failure modes (what makes motion feel cheap)

The slow-mo (600–800 ms everything) · the bouncy castle (bounce everywhere) · the stampede
(equal-weight simultaneous animations) · the teleport swap (spinner then instant content —
use crossfade + rise) · the linear robot (linear easing on enter/exit) · the retrigger
(entrances replaying on rotation/theme change — gate by first reveal) · the input lock ·
the jank (animating layout/size per frame) · the ignored setting (motion running with system
animations off) · magic numbers (`tween(373)` scattered — tokens, always).

### Reference map

| File | Read when |
| --- | --- |
| `references/motion/timing-and-easing.md` | Choosing any duration, easing, or spring; before adding a tokens entry. |
| `references/motion/compose-motion.md` | Any Compose motion work: every API, 10 full recipes, shared elements, navigation, gestures, testing. |
| `references/motion/view-system-motion.md` | Any View/XML work: animators, springs, MotionLayout, AVD, container transforms. |
| `references/motion/micro-interactions-catalog.md` | Deciding what to animate; exact specs per interaction family. |
| `references/motion/performance-and-accessibility.md` | Perf pass before finishing; reduced-motion wiring. |
| `references/motion/review-checklist.md` | Final pass on every motion task. Non-negotiable. |
| `references/motion/MotionTokens.kt` | Drop-in tokens template (durations, M3 easings, springs, reduced-motion provider). |

### Foundations
- Establish type scale, color roles, spacing grid (8dp), shape tokens, elevation, iconography.
- Enforce contrast (>=4.5:1 normal, >=3:1 large), line length 45-75 chars, line height 1.4-1.6.
- Guide motion: functional, 100-500ms, respect reduced motion.
- Anti-patterns: hardcoded colors/sizes; ignoring dark mode; text in dp; decorative-only motion.

### Adaptive layouts
- Use WindowSizeClass (compact/medium/expanded) for responsive layouts.
- Apply canonical layouts: list-detail, supporting pane, feed.
- Use NavigationSuiteScaffold to switch bottom nav / rail / drawer.
- Handle foldables (tabletop/book posture, hinge), multi-window, freeform.
- Support mouse/trackpad/keyboard/stylus with hover and focus.
- Anti-patterns: fixed widths; assuming full-screen; ignoring orientation; content across hinges.

## When to use me
- Building or refactoring Compose screens.
- Reviewing UI quality, performance, or accessibility.
- Adaptive, motion, or M3 token work (consolidated here).

---

## Design bar (adapted from Appllama's app-design skill, for Compose/Android)

You are building screens that sit on a phone next to the best-designed apps in
the world. The user compares your output to those apps within seconds. This
section defines the bar and the method for clearing it, translated to
Jetpack Compose + Material 3 + Android.

### Prime directive: study before you draw

Never design a screen from imagination when you can study how top Android apps
solved the same screen. Real, shipping, revenue-ranked apps encode thousands of
hours of design iteration. Your first move on any screen is research:

1. Study 10–30 real reference screens for the category and screen type (Play
   Store listings, Mobbin, design galleries, or a connected design MCP). Study
   them side by side, not from metadata.
2. Extract the **pattern, not the pixels**: layout skeleton, information
   hierarchy, control choices, spacing rhythm, where the primary CTA sits, what
   gets illustration vs. plain text, how progress is communicated.
3. Then design **your** screen: same proven skeleton, your product's voice.
   Copying a competitor 1:1 is lazy and risky; ignoring every convention
   users know is worse.

### Native fidelity laws (Compose/Material 3)

1. **Semantic colors, both themes, day one.** Use `MaterialTheme.colorScheme.*`,
   never hardcoded hex for text/surfaces. Verify light + dark before "done".
   Never pass semantic color objects into animation specs — resolve to strings first.
2. **Native controls over rebuilt ones.** Use `Switch`, `Slider`, `SegmentedButton`,
   context menus, date pickers from Material 3. Rebuilt toggles that animate
   50 ms differently read as fake instantly.
3. **Iconography.** Material Symbols (or a single chosen family) for chrome;
   SF-Symbol-style weight/optical-size discipline. Do not mix three icon
   families on one screen. No emoji as iconography.
4. **Typography is hierarchy.** Use the M3 type scale (display/headline/title/body/label
   × S/M/L + emphasized). One display size per screen. Tabular numerals
   (`FontFeatureSettings = "tnum"`) for counts, times, prices. Selectable text
   where users may want to copy.
5. **Continuous corners.** `borderCurve`/shape tokens with continuous (squircle)
   corners where the platform supports them; one corner-radius scale, stated as
   a rule ("actions are pills, cards 16, inputs 8") and never violated.
6. **Elevation via Material elevation**, not ad-hoc shadows. One elevation
   system per app.
7. **Spacing rhythm.** Pick a base unit (4 or 8 dp) and never leave it. Prefer
   `Arrangement.spacedBy` over margin stacking. ScrollView padding goes in
   `contentPadding`, never on the scroll container itself.
8. **Safe areas / insets / display cutouts.** Verify with content scrolled under
   the status bar, with the navigation bar / gesture insets, and in landscape
   if supported. Use `WindowInsets` and `systemBarsPadding()`.
9. **Navigation titles belong to the navigator.** Use the NavHost/top app bar
   native title (and large-title collapse on Material 3) rather than a
   hand-rolled header whenever possible.
10. **Haptics are punctuation.** Selection tick when a value passes a step, light
    impact when something snaps home, success/error for outcomes — on the same
    frame as the visual, one per user action, never the only feedback. Never on
    scroll, never in loops. Use `LocalHapticFeedback`.
11. **Format numbers like a product, not a database:** 1.4M, 38k, $4.99. Trim
    trailing zeros. Localize dates.
12. **Root scroll behavior:** screens that can ever overflow wrap content in a
    `verticalScroll` (or `LazyColumn`) with `contentInsetAdjustmentBehavior`-
    equivalent insets. Use `BoxWithConstraints`/`WindowSizeClass`, never
    `Dimensions.get()`.

### Navigation laws

Navigation is the part a screenshot can't show, and users feel it in ten seconds.
Every transition answers: what is the destination, must the user come back, and
what does back (system back, predictive back) do afterwards.

1. **Push goes deeper, replace moves on.** `navController.navigate()` with
   default back stack when the user will return; `popUpTo(...){ inclusive = true }`
   / `navigate` with `launchSingleTop` when coming back would land in a state
   the world has moved past. Back undoes *navigation*, never *events*.
2. **Presentation is meaning.** Self-contained task with steps → modal
   destination with its own back stack and Cancel/Done; short interruption
   (picker, filters) → bottom sheet (`ModalBottomSheet`) with drag-to-dismiss;
   immersive → full-screen modal with explicit Close; floating over a
   still-visible screen → overlay; destructive confirms → action sheet.
   A sheet that grows a second step was a modal all along.
3. **One-way doors leave the stack.** Sign-in, finished onboarding (Skip
   included), purchase, completed session: guard with a `Stack.Protected`-
   equivalent (conditional navigation / `popUpTo` graph root) and land with
   replace, so back can never re-enter the old state. Keep the user's *place*:
   sign-in demanded by one action is a modal over the screen that completes
   the action where tapped; a paywall opened from a feature dismisses back onto
   the feature, unlocked.
4. **Back is blocked in exactly two cases** — an irreversible request in flight
   (seconds, visible progress) and unsaved work in a modal (ask first), via
   `BackHandler`. Transient in-screen state consumes the first back, then back
   leaves. Anything else that traps back is a defect.
5. **Tabs are peers.** No slide between tabs; each tab keeps its own back
   stack; re-tapping the active tab pops to root. Full-attention screens live
   in the root nav above the tabs. Deep links land with a real stack underneath.
6. **Study the grammar, not just the pixels.** Walking a winning flow, note
   what each step *is* (push, modal, sheet) and copy that consistency.

### Anti-slop laws

AI-built apps share a look users file under "template" within seconds. Each is a
default ban; override only when the brand explicitly asks AND you can articulate
why it fits.

1. **No AI-default styling** — purple/indigo gradient CTAs with glow,
   glassmorphism on every card, mesh-gradient heroes, confetti for minor events,
   sparkles in headings. Palette/materials/layout come from reference screens.
2. **One accent, locked.** One accent color is THE accent on every screen.
   Neutrals carry the app; the accent is spent where the money is.
3. **One grey family** (warm or cool), never both.
4. **Shape lock.** One corner-radius scale, stated as a rule, never violated.
5. **No emoji as iconography** (see fidelity law 3).
6. **One label per intent.** "Get started", "Start now", "Begin" are the same
   intent — pick one phrasing everywhere.
7. **Emphasis stays in the family** (weight/italic of the same typeface).
8. **Ship full state cycles**, not the happy path: skeletons match final layout
   shape, empty states composed (say how to fill them), errors inline and
   specific.
9. **Slop pre-flight is mechanical.** Before any flow reaches the emulator
   pass, count: distinct accent hues (must be 1), distinct corner radii (all
   from stated scale), emoji in chrome (0), gradients without brand reason (0),
   duplicate labels for one intent (0). A failed count is a fix.

### Motion laws

Decide in this order:
- **Frequency gate first.** Met 100+/day (tab switch, keyboard, scroll, back) →
  platform default only; tens/day (press, row select) → near-imperceptible, under
  150 ms; occasional (sheets, modals, toasts) → standard motion; delight only on
  rare first-time moments. Tabs never slide. Passing with zero lines of code is a
  success — when unsure, delete the animation.
- **Name the purpose in one word** (feedback, spatial continuity, state change,
  preventing a jarring cut, explanation, delight) or don't build it. Data the
  user is reading never moves for style.
- **If a finger was involved, it's a spring.** Start from the live value, hand
  release velocity into the spring, pick the target from projected momentum,
  rubber-band past boundaries, stay grabbable mid-flight. One vocabulary per app.
- **Everything else is timing, under 300 ms, strong ease-out**
  (`FastOutSlowInEasing`/cubic-bezier(0.23,1,0.32,1)); never ease-in on an
  entrance. Press feedback on press-in, 100–150 ms: scale 0.97 on buttons/cards,
  background highlight (never scale) on list rows, opacity on bar buttons. Exits
  faster than entrances and leave the way they came in.
- **Gesture → animation never hops the main thread.** Use `Animatable`/`animate*AsState`
  with state hoisting; for gestures use `pointerInput` + `Animatable.snapTo`/
  `animateTo` with velocity; `transform`/`opacity` only; never animate a header's
  height (translate inside a fixed clip); keyboard tracking via `WindowInsets.ime`.
- **Respect Reduce Motion:** spatial motion collapses to cross-fades; native
  transitions stay the system's.
- Bar: 60 fps through the hero flow, measured on a **release build on the slowest
  device you support**.

### State architecture

- **Server state** in a repository + `Flow`/`StateFlow` (or ViewModel + coroutines),
  with caching/retries. Never `LaunchedEffect` + raw fetch.
- **Client state** in a small store (ViewModel scoped to nav graph). Broad "app
  state" objects cause re-render cascades.
- **Ephemeral UI state** (open/closed, focus, scroll) stays local to the composable.
- **Optimistic by default:** taps reflect instantly, reconcile in background,
  roll back loudly on failure.
- Uncontrolled `BasicTextField` for high-frequency typing; controlled inputs are a
  top-3 cause of typing jank.
- Persist tiny client state in DataStore, not SharedPreferences, when latency shows.

### Perceived performance

- Skeletons only for content whose shape you know; otherwise progressive reveal.
  Never a full-screen spinner for a partial update.
- `LazyColumn`/`LazyVerticalGrid` for every list; stable keys + `contentType`.
- Preload the next screen's data on press-in, not on navigation-complete.
- Images: right-size sources, Coil with `crossfade`, placeholders.
- Cold-start TTI and bundle discipline: measure → optimize → re-measure, never
  blind memoization.

### Image & illustration assets

- Generate assets with the best image model available at highest quality, then
  downscale to @1x/@2x/@3x. Never upscale.
- One visual language per app: pick a style and generate ALL assets in that same
  style, palette, lighting. Mixed-style reads as template slop.
- Prompt for transparent or solid-flat backgrounds matched to surface color;
  compositing artifacts are an automatic redo.

### The simulator loop (non-negotiable)

A screen does not exist until you have seen it running. The loop:
1. Implement → launch in the Android emulator.
2. Screenshot and **actually look**: alignment, optical centering, spacing rhythm,
   truncation with long content, dark mode, font scaling at XL.
3. Run the **full-motion pass** below — screenshots prove layout, nothing about motion.
4. Fix, relaunch, re-verify. Repeat until you cannot find a defect.

#### Full-motion pass (mandatory, per flow)

Screen-record the entire flow end to end
(`adb shell screenrecord /sdcard/flow.mp4`), exercising ALL of it: every transition,
every back path (system back, predictive back), every modal/sheet (present, drag,
dismiss, cancel mid-drag), keyboard both directions, every interaction (press
states, gesture follow-through, interrupted gestures, rapid taps, scroll flings).

Watch twice: once full speed for feel, once scrubbing frame by frame. Hunt:
- dropped/stuttered frames (bar is sustained 60 fps, measured)
- one-frame flashes (white/unstyled first paint, wrong-theme frames, color pops)
- layout jumps, double-render pops, springs clipping/overshooting

One glitchy frame means the flow is not done.

### Definition of done, per screen

- [ ] Studied 10+ real reference screens for this screen type and can name the
      pattern adopted
- [ ] Navigation answered: what this screen *is* (push/modal/sheet/overlay/replace),
      what back does, and — behind a one-way door — that back cannot re-enter
- [ ] Light + dark mode verified in the emulator
- [ ] Safe areas / cutouts / nav bar / gesture insets verified
- [ ] Long-content, empty, loading, error states designed — not defaulted
- [ ] Motion: full flow recorded and scrubbed — entrances, presses, transitions,
      modals, keyboard — native feel, zero glitch/wrong-color frames; Reduce Motion
      respected; 60 fps measured on a release build on the slowest supported device
- [ ] Font scaling XL doesn't break layout; text selectable where useful
- [ ] All tap targets ≥ 48 dp; contrast passes in both themes
- [ ] Assets: single style family, crisp, no compositing halos
- [ ] List surfaces virtualized; no controlled-input jank; no re-render storms
      (profiled, not guessed)
