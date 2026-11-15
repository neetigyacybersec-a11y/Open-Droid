package com.example.packs.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.packs.data.Note
import com.example.packs.data.NotesRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

@HiltViewModel
class HomeViewModel @Inject constructor(
    private val repository: NotesRepository,
) : ViewModel() {
    val notes: StateFlow<List<Note>> =
        repository.notes().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    val darkMode: StateFlow<Boolean> =
        repository.darkMode.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), false)

    fun save(title: String) {
        viewModelScope.launch { repository.save(title) }
    }
}
