package com.example.starter

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.AccessibilityCheckAfterTestStrategy
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.RoborazziATFAccessibilityCheckOptions
import com.github.takahirom.roborazzi.RoborazziATFAccessibilityChecker
import com.github.takahirom.roborazzi.RoborazziRule
import com.google.android.apps.common.testing.accessibility.framework.AccessibilityCheckPreset
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

// FR-B2 slice 2: a11y layer. Google's Accessibility Test Framework (ATF) runs
// the LATEST preset against the real Compose tree after each test, on the JVM.
@OptIn(ExperimentalRoborazziApi::class)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], packageName = "com.example.starter")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GreetingA11yTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val roborazziRule = RoborazziRule(
        composeRule = composeRule,
        captureRoot = composeRule.onRoot(),
        options = RoborazziRule.Options(
            roborazziAccessibilityOptions = RoborazziATFAccessibilityCheckOptions(
                checker = RoborazziATFAccessibilityChecker(
                    preset = AccessibilityCheckPreset.LATEST,
                ),
                failureLevel = RoborazziATFAccessibilityChecker.CheckLevel.Error,
            ),
            accessibilityCheckStrategy = AccessibilityCheckAfterTestStrategy(),
        ),
    )

    @Test
    fun greetingScreenPassesAccessibilityChecks() {
        // Checks run automatically after this test via accessibilityCheckStrategy.
    }
}
