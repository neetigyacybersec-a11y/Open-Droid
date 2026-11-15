package com.example.packs.di

import android.content.Context
import androidx.room.Room
import com.example.packs.data.AppDatabase
import com.example.packs.data.DefaultNotesRepository
import com.example.packs.data.NoteDao
import com.example.packs.data.NotesRepository
import com.example.packs.network.NoteApi
import dagger.Binds
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit

@Module
@InstallIn(SingletonComponent::class)
object AppModule {
    @Provides
    @Singleton
    fun database(@ApplicationContext context: Context): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, "packs.db").build()

    @Provides
    fun noteDao(database: AppDatabase): NoteDao = database.noteDao()

    @Provides
    @Singleton
    fun json(): Json = Json { ignoreUnknownKeys = true }

    @Provides
    @Singleton
    fun okHttp(): OkHttpClient =
        OkHttpClient.Builder()
            .addInterceptor(HttpLoggingInterceptor().apply { level = HttpLoggingInterceptor.Level.BASIC })
            .build()

    @Provides
    @Singleton
    fun retrofit(client: OkHttpClient): Retrofit =
        Retrofit.Builder()
            .baseUrl("https://example.com/")
            .client(client)
            .build()

    @Provides
    @Singleton
    fun noteApi(retrofit: Retrofit): NoteApi = retrofit.create(NoteApi::class.java)
}

@Module
@InstallIn(SingletonComponent::class)
abstract class BindingsModule {
    @Binds
    @Singleton
    abstract fun bindNotesRepository(repository: DefaultNotesRepository): NotesRepository
}
