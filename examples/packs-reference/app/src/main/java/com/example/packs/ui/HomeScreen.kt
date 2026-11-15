package com.example.packs.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.example.packs.data.Note

@Composable
fun HomeScreen(
    notes: List<Note>,
    darkMode: Boolean,
    onSave: (String) -> Unit,
    onOpen: (String) -> Unit,
) {
    var title by rememberSaveable { mutableStateOf("") }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Packs reference", style = MaterialTheme.typography.headlineMedium)
        Text(if (darkMode) "Dark mode is on" else "Light mode")

        AsyncImage(
            model = "https://example.com/packs-reference.png",
            contentDescription = "Reference artwork",
        )

        OutlinedTextField(
            value = title,
            onValueChange = { title = it },
            label = { Text("Title") },
        )
        Button(
            onClick = {
                if (title.isNotBlank()) {
                    onSave(title)
                    title = ""
                }
            },
        ) {
            Text("Save note")
        }

        if (notes.isEmpty()) {
            Text("No notes yet")
        }

        LazyColumn {
            items(notes, key = { note -> note.id }) { note ->
                TextButton(onClick = { onOpen(note.title) }) {
                    Text(note.title)
                }
            }
        }
    }
}
