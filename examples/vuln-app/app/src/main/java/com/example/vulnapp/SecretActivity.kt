package com.example.vulnapp

import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.ComponentActivity

/**
 * Practice target for the dynamic-analysis loop.
 *
 * The gate is deliberately inverted: the secret is shown when the device does
 * NOT look rooted. A Frida hook that makes [RootCheck.isRooted] return false
 * "bypasses" the check, which is the behaviour `frida-scripts/root-bypass.js`
 * demonstrates.
 */
class SecretActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!RootCheck.isRooted()) {
            Toast.makeText(this, "SECRET ACCESS GRANTED", Toast.LENGTH_LONG).show()
            Log.d(TAG, "SECRET ACCESS GRANTED")
        } else {
            Toast.makeText(this, "rooted device blocked", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    private companion object {
        const val TAG = "SecretActivity"
    }
}
