package com.example.vulnapp

import java.io.File

object RootCheck {
    fun isRooted(): Boolean {
        val paths = listOf("/system/bin/su", "/sbin/magisk")
        return paths.any { File(it).exists() }
    }
}
