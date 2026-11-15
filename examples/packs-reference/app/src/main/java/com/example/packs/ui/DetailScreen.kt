package com.example.packs.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable
fun DetailScreen(title: String) {
    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text(title.ifBlank { "Note" }, style = MaterialTheme.typography.headlineSmall)
        Text("Navigation and state survive a round trip.")
    }
}
