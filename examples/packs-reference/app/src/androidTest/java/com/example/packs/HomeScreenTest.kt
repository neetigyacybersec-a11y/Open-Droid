package com.example.packs

import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.example.packs.ui.HomeScreen
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HomeScreenTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun emptyStateShowsTheSaveAffordance() {
        composeRule.setContent {
            MaterialTheme {
                HomeScreen(
                    notes = emptyList(),
                    darkMode = false,
                    onSave = {},
                    onOpen = {},
                )
            }
        }

        composeRule.onNodeWithText("No notes yet").assertIsDisplayed()
        composeRule.onNodeWithText("Save note").assertIsDisplayed()
    }
}
