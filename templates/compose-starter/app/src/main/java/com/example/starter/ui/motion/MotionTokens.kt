/*
 * MotionTokens.kt — single source of truth for all motion in the app.
 * FR-B5 / FR-S1: durations, Material 3 easings, spring presets and the
 * reduced-motion provider. Use ONLY these tokens everywhere — never hardcode
 * a duration or easing inline. Rationale: android-compose-ui-ux skill,
 * references/motion/timing-and-easing.md.
 */
package com.example.starter.ui.motion

import android.provider.Settings
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
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect

/** Durations (ms). */
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

/** Easings — the Material 3 set. Never use LinearEasing for enter/exit. */
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
 * Spring presets. Bounce is allowed only via [MotionSprings.playful], at most
 * once per screen.
 */
object MotionSprings {
    /** Mechanical click: thumb into rail, indicator landing. */
    fun <T> instant() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessHigh)

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
 * read it ourselves. The value is state, re-read whenever the app resumes:
 * changing ANIMATOR_DURATION_SCALE in system settings pauses and resumes the
 * activity, and a one-shot read would keep animating until a full restart.
 */
val LocalReduceMotion = staticCompositionLocalOf { false }

/** Backwards-compatible alias; prefer [LocalReduceMotion]. */
@Deprecated("Use LocalReduceMotion", ReplaceWith("LocalReduceMotion"))
val LocalReducedMotion: ProvidableCompositionLocal<Boolean>
    get() = LocalReduceMotion

fun android.content.Context.animatorDurationScale(): Float =
    Settings.Global.getFloat(contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)

/** True when the user disabled animations (animator duration scale 0). */
fun android.content.Context.isReduceMotionEnabled(): Boolean = animatorDurationScale() == 0f

/** Wrap the app root once: MotionSettingsProvider { App() } */
@Composable
fun MotionSettingsProvider(content: @Composable () -> Unit) {
    val context = LocalContext.current
    var reduced by remember(context) { mutableStateOf(context.isReduceMotionEnabled()) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        reduced = context.isReduceMotionEnabled()
    }
    CompositionLocalProvider(LocalReduceMotion provides reduced, content = content)
}

/**
 * Spec helper honoring reduced motion:
 *   animateFloatAsState(target, animationSpec = motionSpec(normal = tween(MotionDurations.Medium, easing = MotionEasings.Emphasized)))
 */
@Composable
fun <T> motionSpec(
    normal: AnimationSpec<T>,
    reduced: Boolean = LocalReduceMotion.current,
): AnimationSpec<T> = if (reduced) snap() else normal

/** Fling decay preset (gesture release), for Animatable fling via animateDecay. */
fun <T> motionFlingDecay() = exponentialDecay<T>(frictionMultiplier = 1.4f)
