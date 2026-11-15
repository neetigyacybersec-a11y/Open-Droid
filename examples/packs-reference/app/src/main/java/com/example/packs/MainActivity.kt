package com.example.packs

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.getValue
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.example.packs.ui.DetailScreen
import com.example.packs.ui.HomeScreen
import com.example.packs.ui.HomeViewModel
import dagger.hilt.android.AndroidEntryPoint

@AndroidEntryPoint
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                val viewModel: HomeViewModel = hiltViewModel()
                val notes by viewModel.notes.collectAsStateWithLifecycle()
                val darkMode by viewModel.darkMode.collectAsStateWithLifecycle()
                val navController = rememberNavController()

                NavHost(navController = navController, startDestination = "home") {
                    composable("home") {
                        HomeScreen(
                            notes = notes,
                            darkMode = darkMode,
                            onSave = viewModel::save,
                            onOpen = { title ->
                                navController.navigate("detail/${Uri.encode(title)}")
                            },
                        )
                    }
                    composable("detail/{title}") { entry ->
                        DetailScreen(title = entry.arguments?.getString("title").orEmpty())
                    }
                }
            }
        }
    }
}
