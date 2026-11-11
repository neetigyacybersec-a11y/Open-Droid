/*
 * MotionTokens.kt — single source of truth for all motion in the app.
 * Drop this file into your project (adjust the package), then use ONLY these
 * tokens everywhere. Full rationale: skill references/timing-and-easing.md
 */
package com.example.app.motion          // TODO: adjust to your project's package

import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.exponentialDecay
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import android.provider.Settings

/**
 * Durations (ms). See references/timing-and-easing.md §2.
 */
object MotionDurations {
    /** Press feedback, icon morphs, chevron flips. */
    const val Fast = 120

    /** Fades, color accents, small content swaps. */
    const val Normal = 200

    /** Standard element transitions: cards, panels, indicators. */
    const val Medium = 280

    /** Large surfaces, screens, sheets. */
    const val Slow = 380

    /** Container transform / shared-element hero. The ceiling. */
    const val Hero = 500

    /** Per-item delay for list staggers (12-30 ms allowed). */
    const val Stagger = 18

    /** Exits are 25-40% faster than entrances. */
    fun exit(durationMs: Int): Int = (durationMs * 0.75f).toInt().coerceAtLeast(90)
}

/**
 * Easings — the Material 3 set. Never use LinearEasing for enter/exit.
 */
object MotionEasings {
    /** Default hero/enter settle. */
    val Emphasized = CubicBezierEasing(0.20f, 0f, 0f, 1f)
    val EmphasizedAccelerate = CubicBezierEasing(0.30f, 0f, 0.80f, 0.15f)
    val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.70f, 0.10f, 1f)
    val StandardAccelerate = CubicBezierEasing(0.30f, 0f, 1f, 1f)
    val StandardDecelerate = CubicBezierEasing(0f, 0f, 0f, 1f)

    /** Loops only. */
    val Linear: Easing = LinearEasing
}

/**
 * Spring presets. See references/timing-and-easing.md §4.
 * Bounce is allowed only via [springPlayful], at most once per screen.
 */
object MotionSprings {
    /** Mechanical click: thumb into rail, indicator landing. */
    fun <T> snap() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessHigh)

    /** Default for state changes, press scale, retargeting. */
    fun <T> crisp() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMedium)

    /** Large elements: sheets, containers, screens. */
    fun <T> soft() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)

    /** One clear overshoot: like/save pops, badge arrival. */
    fun <T> playful() = spring<T>(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMedium)

    /** Soft organic settle: playful chips, drag release. */
    fun <T> gentle() = spring<T>(dampingRatio = Spring.DampingRatioLowBouncy, stiffness = Spring.StiffnessMediumLow)
}

/**
 * Reduced motion: Compose ignores the system animator duration scale, so we
 * read it ourselves. Views respect it automatically.
 */
val LocalReducedMotion = staticCompositionLocalOf { false }

fun android.content.Context.animatorDurationScale(): Float =
    Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

/** Wrap your app root once: MotionSettingsProvider { App() } */
@Composable
fun MotionSettingsProvider(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val reduced = remember { context.animatorDurationScale() == 0f }
    CompositionLocalProvider(LocalReducedMotion provides reduced, content = content)
}

/**
 * Spec helper honoring reduced motion:
 *   animateFloatAsState(target, animationSpec = motionSpec(normal = tween(MotionDurations.Medium, easing = MotionEasings.Emphasized)))
 */
@Composable
fun <T> motionSpec(
    normal: AnimationSpec<T>,
    reduced: Boolean = LocalReducedMotion.current,
): AnimationSpec<T> = if (reduced) snap() else normal

/** Fling decay preset (gesture release), for Animatable fling via animateDecay. */
fun <T> motionFlingDecay() = exponentialDecay<T>(frictionMultiplier = 1.4f)

/*
 * Handy aliases used across the skill docs:
 *   MotionTokens.Normal / Fast / Medium / Slow / Hero  -> use MotionDurations
 *   MotionTokens.Emphasized                            -> use MotionEasings
 *   MotionTokens.springCrisp()                         -> use MotionSprings.crisp()
 * Keep names consistent with SKILL.md §2 rule 1: tokens only, no inline numbers.
 */
