package com.example.packs.data

import androidx.paging.PagingSource
import androidx.room.Dao
import androidx.room.Query
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

@Dao
interface NoteDao {
    @Query("SELECT * FROM notes ORDER BY updatedAt DESC")
    fun observeAll(): Flow<List<Note>>

    @Query("SELECT * FROM notes ORDER BY updatedAt DESC")
    fun pagingSource(): PagingSource<Int, Note>

    @Upsert
    suspend fun upsert(note: Note)

    @Query("DELETE FROM notes")
    suspend fun clear()
}
