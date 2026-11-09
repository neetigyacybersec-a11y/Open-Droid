package com.example.starter

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// Robolectric #4736: AGP 8 manifest no longer carries `package=`, so the intent
// resolver cannot map MainActivity without an explicit packageName.
@Config(sdk = [35], packageName = "com.example.starter")
class GreetingTest {
    @get:Rule
    val rule = createAndroidComposeRule<MainActivity>()

    @Test
    fun greetingIsRenderedAndAccessible() {
        rule.onNodeWithText("Hello Android!").assertIsDisplayed()
    }
}
