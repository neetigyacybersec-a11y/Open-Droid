package com.example.vulnapp

import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class SecretActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (RootCheck.isRooted()) {
            Toast.makeText(this, "SECRET ACCESS GRANTED", Toast.LENGTH_LONG).show()
            Log.d("SecretActivity", "SECRET ACCESS GRANTED")
        } else {
            Toast.makeText(this, "not rooted", Toast.LENGTH_SHORT).show()
            finish()
        }
    }
}
