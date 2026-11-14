package com.example.starter

import android.provider.Settings
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.example.starter.ui.motion.LocalReduceMotion
import com.example.starter.ui.motion.MotionSettingsProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

// ISSUE-23: reading ANIMATOR_DURATION_SCALE only once means a user who disables
// animations keeps seeing them until the process restarts. The provider must
// hold the setting as state and re-read it when the activity resumes.
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], packageName = "com.example.starter")
class ReducedMotionTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    private fun setAnimatorScale(scale: Float) {
        Settings.Global.putFloat(
            rule.activity.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            scale,
        )
    }

    @Test
    fun reducedMotionFollowsTheSystemSettingAcrossResume() {
        var observed: Boolean? = null
        try {
            setAnimatorScale(0f)
            rule.activityRule.scenario.onActivity { activity ->
                activity.setContentView(
                    ComposeView(activity).apply {
                        setContent {
                            MotionSettingsProvider {
                                observed = LocalReduceMotion.current
                            }
                        }
                    },
                )
            }
            rule.waitForIdle()
            assertTrue("animations disabled before first composition", observed == true)

            setAnimatorScale(1f)
            rule.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
            rule.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
            rule.waitForIdle()
            assertFalse("animations re-enabled after onResume", observed == true)
        } finally {
            setAnimatorScale(1f)
        }
    }
}
