package com.example.vulnapp

import android.util.Log
import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import okhttp3.Request

object ApiService {
    private const val TAG = "ApiService"

    fun call() {
        val pinner = CertificatePinner.Builder()
            .add("httpbin.org", "sha256/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
            .build()
        val client = OkHttpClient.Builder().certificatePinner(pinner).build()
        val req = Request.Builder().url("https://httpbin.org/post").build()
        try {
            client.newCall(req).execute().use { resp ->
                Log.d(TAG, "response ${resp.code}")
            }
        } catch (e: Exception) {
            Log.d(TAG, "pin check failed (expected in demo): ${e.message}")
        }
    }
}
