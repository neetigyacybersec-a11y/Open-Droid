package com.example.packs

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import com.example.packs.data.AppDatabase
import com.example.packs.data.Note
import com.example.packs.data.NoteDao
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class NoteDaoTest {
    private lateinit var database: AppDatabase
    private lateinit var dao: NoteDao

    @Before
    fun setUp() {
        database =
            Room.inMemoryDatabaseBuilder(
                ApplicationProvider.getApplicationContext(),
                AppDatabase::class.java,
            ).allowMainThreadQueries().build()
        dao = database.noteDao()
    }

    @After
    fun tearDown() {
        database.close()
    }

    @Test
    fun upsertIsVisibleThroughTheObservedFlow() = runTest {
        dao.upsert(Note(id = 1L, title = "Offline note", updatedAt = 10L))

        assertEquals(listOf("Offline note"), dao.observeAll().first().map { it.title })
    }
}
