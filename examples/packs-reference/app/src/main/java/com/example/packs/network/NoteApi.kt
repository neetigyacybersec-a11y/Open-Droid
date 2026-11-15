package com.example.packs.network

import okhttp3.ResponseBody
import retrofit2.http.GET

interface NoteApi {
    @GET("notes")
    suspend fun notes(): ResponseBody
}
