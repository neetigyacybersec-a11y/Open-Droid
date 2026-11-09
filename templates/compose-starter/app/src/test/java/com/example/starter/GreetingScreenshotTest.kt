package com.example.starter

import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

// FR-B2 slice 2: screenshot layer. Runs on the JVM (Robolectric) with no emulator.
// Record:   gradle :app:testDebugUnitTest -Proborazzi.test.record=true
// Verify:   gradle :app:testDebugUnitTest -Proborazzi.test.verify=true  (fails on pixel diff)
@RunWith(AndroidJUnit4::class)
@Config(sdk = [35], packageName = "com.example.starter")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class GreetingScreenshotTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun greetingScreenMatchesGolden() {
        // Let the activity settle, then capture the committed golden.
        rule.waitForIdle()
        rule.onRoot().captureRoboImage("src/test/screenshots/greeting_screen.png")
    }
}
