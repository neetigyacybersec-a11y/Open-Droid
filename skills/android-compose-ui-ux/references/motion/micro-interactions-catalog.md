# Micro-interactions Catalog — intent → exact spec

The taste encyclopedia. Each entry: **when**, the **spec** (duration/easing/properties), **haptic**, and **accessibility** note. Implement via `references/compose-motion.md` (Compose) or `references/view-system-motion.md` (Views) — specs here are platform-neutral.

Formatting per entry: **Trigger → Spec → Haptic → Notes**.

## Contents
1. Touch feedback (press/release)
2. Toggles & selection (switch, checkbox, chips, segmented, radio)
3. Like / save / bookmark / follow
4. Expand & collapse (cards, accordions, "more")
5. List & grid: first load, insert/remove, reorder
6. Swipe actions & dismissal
7. Bottom sheets & dialogs
8. FAB & toolbar morphs
9. Screen-to-screen navigation
10. Loading: skeletons, spinners, buttons
11. Content changes: counters, badges, text swap
12. Empty ↔ content, error ↔ retry
13. Splash → home
14. Onboarding & walkthroughs
15. Pull-to-refresh & scroll-linked headers
16. Haptic mapping summary

---

## 1. Touch feedback (press/release)

**Every** touchable gets ripple (platform default). Primary touchables (CTA button, FAB, media cards, primary rows) additionally get scale.

**Spec:** down → scale 1.0→0.97 (fast, ~120 ms feel via `springCrisp` retarget); up → spring back to 1.0. No fade. Never below 0.94 (reads as "broken"); never above 1.0 on press.
**Haptic:** none (ripple is enough).
**Notes:** scale accompanies ripple — replacing ripple with scale feels wrong on Android. Disabled controls: no animation.

## 2. Toggles & selection

**Switch:** thumb slides (spring `crisp`, ~150 ms feel), track color crossfades (`Normal`, tween). Thumb never fades — it's the moving identity.
**Checkbox/radio:** draw check/radio glyph with trim-path or scale-in 0.6→1.0 (`Fast`, decelerate), box color fades (`Normal`). Un-check reverses with `exit(Fast)`.
**Chips / segmented control:** selected chip background fades+expands (`Normal`), label color fades; in segmented controls the indicator **slides** between segments (spring `crisp` ~200 ms feel) rather than fading per segment — sliding shows "one of N".
**Notes:** selected state must be visible statically after animation (a11y, §perf-a11y). Selection changes fire at most one haptic.

## 3. Like / save / bookmark / follow

**Spec (the sanctioned bounce):** dip to 0.8 (instant or `Fast`) → overshoot to 1.15 with `StandardDecelerate` (`Fast`) → settle 1.0 with `springPlayful`. Total ~250 ms. Fill color crossfades to accent (`Normal`).
**Haptic:** `LongPress`/`CONFIRM` at the moment the accent color lands.
**Notes:** this is the only pattern where bounce is default-allowed. Reverse (unlike) = quick fade + settle, no bounce. Rapid re-tap: LaunchedEffect cancel semantics make it re-run cleanly — verify by mashing.

## 4. Expand & collapse

**Spec:** `animateContentSize` with `springSoft` (or `updateTransition` when ≥2 properties change). Content fades in as it grows (`Normal`, decelerate), fades out first on collapse (`exit(Normal)`, accelerate). Chevron/arrow rotates 180° (`Fast`, emphasized).
**Haptic:** none.
**Notes:** width changes too? Keep alignment anchored (`Alignment.TopStart` or the visually-stable corner). Never collapse to zero then swap layouts — collapse into the summary state. Tall content (>2 screens): don't animate the height — jump with a content fade, or cap expansion height and scroll.

## 5. Lists & grids

**First load (once per session):** items fade + rise 12 dp, 18 ms stagger (12–30 max), item duration `Medium`, `EmphasizedDecelerate`, total window ≤ 350 ms (cap tail — late items animate together). Images fade in on load separately (placeholder → `Normal` fade) — don't block the stagger on images.
**Insert:** new item slides from below/above 100%→0 within its slot (`Medium`, decelerate) + others shift with the default item animator.
**Remove:** collapse height (scaleY toward neighbors or height animator) + fade (`exit(Medium)`), neighbors move to fill (`Medium`).
**Reorder (drag):** item lifts (scale 1.04, shadow, `Fast`), follows finger 1:1, neighbors part/swap with `crisp` spring, drop settles with `springSoft`.
**Notes:** never re-run first-load stagger on back-navigation or config change. Use payload-based `notifyItemChanged` so updates don't re-fade whole rows.

## 6. Swipe actions & dismissal

**Spec:** while swiping, action background reveals at fixed position behind the item; item tracks finger 1:1 (no easing). Threshold crossing = small resistance change + `GESTURE_START` haptic. Release: if past threshold → item springs out (`springSoft` seeded with gesture velocity) then row collapses (`exit(Medium)`); else → spring back (`springCrisp`).
**Haptic:** threshold crossing only.
**Notes:** action icons behind stay static (no pulsing). Undo = snackbar (§7) — the undo restore slides the item back from the same side it left (`Medium`, decelerate).

## 7. Bottom sheets & dialogs

**Bottom sheet:** scrim fades 0→0.5 (`Medium`); sheet slides from bottom 1:1 with drag above the anchor point, spring `soft` settle on release (`Slow` feel); expanded↔collapsed snaps to nearest anchor or fling direction. Dismiss: sheet slides out (accelerate, `exit(Slow)`) + scrim fades behind it, overlapped — never sequential.
**Dialog:** fade + scale 0.92→1.0 (`Medium` enter decelerate; `exit(Normal)` exit accelerate). Dismiss-drag (sheets): track finger, release commits with spring or springs back.
**Haptic:** none on open; `CONFIRM` on destructive commit (after action, not before).
**Notes:** input focus must land before motion ends (TalkBack). Back gesture inside sheet = dismiss, same animation.

## 8. FAB & toolbar morphs

**Spec:** container transform — FAB expands to full screen/header (`Hero` 500 ms, `Emphasized`); destination content staggers in after ~60% of morph (fade + 12 dp rise, `Medium`); collapsing runs `exit(Hero)` with accelerate and content fades *before* the container shrinks.
**Notes:** one hero: the container. Title/text on both ends: shared bounds crossfade. In View land use `MaterialContainerTransform`; Compose uses shared elements (`compose-motion.md` §10). FAB → toolbar on scroll (shrink/extend): 180 ms, emphasized, icon crossfades — no size spring (scroll-linked must feel attached).

## 9. Screen-to-screen navigation

**Sibling (same hierarchy):** shared-axis X — forward: new screen slides from end 16–24% width + fade-in (`Medium`, `StandardDecelerate`), old screen fades out quicker (`exit(Medium)`); back = mirrored.
**Parent→child (drill-in):** container transform (§8) when origin is a card/media; otherwise forward slide from end + fade.
**Modal flows:** current screen scales to 0.96 + dims (`Medium`), new screen fades+rises on top.
**Tabs (top-level):** crossfade only (`Normal`) — slides between top-level destinations feel wrong (spatial distance is fake).
**Notes:** exits faster than enters, always. Direction must mirror on pop. RTL-aware offsets.

## 10. Loading

**Skeleton (preferred):** pulse opacity 1.0↔0.45, 900 ms, linear, `RepeatMode.Reverse`. Skeleton shapes mirror real layout (no jarring swap). Content replaces skeleton with crossfade (`Normal`) — skeletons must never shrink/grow during pulse.
**Shimmer variant (only if brand calls for it):** diagonal light band sweeps, 1200–1600 ms loop, band ≤ 25% width, low contrast (premium apps keep shimmer subtle). Never multiple shimmering elements out of phase — sync them.
**Spinner:** platform `CircularProgressIndicator`; on success→content, crossfade; on fail→error state crossfade + shake? No — shake is for input errors only. Button loading: label fades out, spinner fades in, button width holds (`animateContentSize` if it must shrink); success morphs spinner→check (`Fast` trim-path) + `CONFIRM` haptic.
**Notes:** never block interaction behind a full-screen spinner unless the action is destructive/irreversible.

## 11. Content changes (counters, badges, text)

**Counter (cart qty, score):** vertical slide swap — increment: old slides up-out, new slides up-in from below (`Normal`, decelerate in / accelerate out). Decrement mirrors. §5.3 in SKILL.md has the code.
**Badge arrival:** scale 0→1 with `springPlayful` (the one bounce allowed here), content pops at 60%.
**Text swap (same position):** crossfade + 4 dp rise (`Fast`–`Normal`); if length changes, `animateContentSize`.
**Tab underline/indicator:** slides (spring `crisp`), width animates if labels differ (`Medium`).

## 12. Empty ↔ content, error ↔ retry

**Empty→content:** empty state fades out (`exit(Fast)`), content fades in + rises 16 dp (`Medium`, decelerate). Container height changes via `animateContentSize` — empty art collapsing into real content is premium if shapes roughly correspond.
**Error→retry:** error banner slides down from top (`Medium`), auto-dismiss slides up (`exit(Medium)`). Retry button press = §1. On success, banner slides up; nothing shakes.
**Shake is reserved** for invalid *input* the user just typed (form fields), 2 oscillations, 6 dp amplitude, 200 ms total, paired with `REJECT` haptic. Anywhere else it's cartoonish.

## 13. Splash → home

**Spec:** brand mark scales 0.92→1.0 + fades in (180 ms, `StandardDecelerate`) — then *hold* ≤ 400 ms while loading — content area fades in + rises 12 dp (`Medium`). No looping logo animation, no counter, no fake progress.
**Notes:** total ≤ 600 ms of authored motion; the rest must be real loading. Use `windowSplashScreenAnimatedIcon` API (androidx.core SplashScreen) with a static-ish icon.

## 14. Onboarding & walkthroughs

**Page transitions:** horizontal slide 1:4 of viewport + fade (`Medium`); progress dots crossfade active state + width morph pill (`Fast`). Illustration inside a page: one entrance (fade + rise 12 dp, staggered with text 40 ms).
**Coach marks:** spotlight hole fades in with scrim (`Medium`), tooltip rises 8 dp after 100 ms.
**Notes:** never auto-advance; motion must not trap users (all info reachable without animation — a11y).

## 15. Pull-to-refresh & scroll-linked

**Pull-to-refresh:** indicator tracks pull 1:1 (rotation/scale proportional to overscroll, damped past max), threshold arm = `GESTURE_START` tick, release below threshold → spring back (`crisp`), above → spinner handoff + content refresh crossfade (§10).
**Collapsing header:** scale/translate/alpha track scroll fraction via `derivedStateOf`/MotionLayout — zero spring while finger is on screen; on release mid-way, settle to nearest state (`springSoft`). Parallax ≤ 0.5× scroll rate on imagery. Toolbar elevation fades in past threshold (`Normal`).

## 16. Haptic mapping summary

| Event | Feedback |
| --- | --- |
| Like/save confirm | `LongPress` / `CONFIRM` (API 30+) |
| Toggle ON | `CONFIRM` (silent for OFF) |
| Selection/segment/step | `TextHandleMove` / `CLOCK_TICK` |
| Gesture threshold armed | `GESTURE_START` (API 30+) |
| Invalid input (shake) | `REJECT` (API 30+) |
| Destructive action done | `REJECT` — then the result speaks for itself |

Rules: haptics fire on state change, once. Never during continuous motion. Always pair with the visual event landing (not the press). Users with system feedback off get nothing — that's correct.
