package com.example.packs

import app.cash.turbine.test
import com.example.packs.data.Note
import com.example.packs.data.NotesRepository
import com.example.packs.ui.HomeViewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class HomeViewModelTest {
    private val dispatcher = StandardTestDispatcher()
    private val notes = MutableStateFlow<List<Note>>(emptyList())

    private val fakeRepository = object : NotesRepository {
        override fun notes(): Flow<List<Note>> = notes

        override val darkMode: Flow<Boolean> = MutableStateFlow(true)

        override suspend fun save(title: String) {
            notes.value = notes.value + Note(id = 1L, title = title, updatedAt = 1L)
        }

        override suspend fun refresh(): Result<Unit> = Result.success(Unit)
    }

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun emitsSavedNotesFromStateFlow() = runTest(dispatcher) {
        val viewModel = HomeViewModel(fakeRepository)

        viewModel.notes.test {
            assertEquals(emptyList<Note>(), awaitItem())

            viewModel.save("Review dependency packs")
            advanceUntilIdle()

            assertEquals("Review dependency packs", awaitItem().single().title)
        }
    }
}
