package com.example.vulnapp

import android.util.Log
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

object CryptoBox {
    private const val TAG = "CryptoBox"
    private val keyBytes = "vuln-demo-key-32-bytes-long!".toByteArray(Charsets.UTF_8)
    private val key = SecretKeySpec(keyBytes, "AES")

    fun encrypt(plain: String): String {
        Log.d(TAG, "encrypting: $plain")
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.ENCRYPT_MODE, key, IvParameterSpec(ByteArray(16)))
        val out = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return android.util.Base64.encodeToString(out, android.util.Base64.NO_WRAP)
    }

    fun decrypt(b64: String): String {
        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(Cipher.DECRYPT_MODE, key, IvParameterSpec(ByteArray(16)))
        val out = cipher.doFinal(android.util.Base64.decode(b64, android.util.Base64.NO_WRAP))
        return String(out, Charsets.UTF_8)
    }
}
