package com.example.packs.data

import androidx.paging.Pager
import androidx.paging.PagingConfig
import androidx.paging.PagingData
import com.example.packs.network.NoteApi
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.Flow

interface NotesRepository {
    fun notes(): Flow<List<Note>>
    val darkMode: Flow<Boolean>
    suspend fun save(title: String)
    suspend fun refresh(): Result<Unit>
}

@Singleton
class DefaultNotesRepository @Inject constructor(
    private val dao: NoteDao,
    private val api: NoteApi,
    private val settings: SettingsRepository,
) : NotesRepository {
    override fun notes(): Flow<List<Note>> = dao.observeAll()

    override val darkMode: Flow<Boolean> = settings.darkMode

    override suspend fun save(title: String) {
        val now = System.currentTimeMillis()
        dao.upsert(Note(id = now, title = title, updatedAt = now))
    }

    override suspend fun refresh(): Result<Unit> = runCatching {
        api.notes().close()
        dao.upsert(Note(id = 1L, title = "Fetched from network", updatedAt = System.currentTimeMillis()))
    }

    /** Paging pack consumer; the UI keeps this example to one screen. */
    fun pagedNotes(pageSize: Int = 20): Flow<PagingData<Note>> =
        Pager(PagingConfig(pageSize = pageSize)) { dao.pagingSource() }.flow
}
