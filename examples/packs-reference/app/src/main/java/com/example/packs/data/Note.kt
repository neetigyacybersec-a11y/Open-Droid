package com.example.packs.data

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "notes")
data class Note(
    @PrimaryKey val id: Long,
    val title: String,
    val updatedAt: Long,
)
