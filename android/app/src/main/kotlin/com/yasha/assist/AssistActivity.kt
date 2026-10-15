package com.yasha.assist

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity

// Transparent trampoline for ACTION_ASSIST / ACTION_ASSIST_INPUT (and the
// M3 corner-swipe surface): routes the trigger into the floaty, which falls
// back to MainActivity itself when signed out.
class AssistActivity : ComponentActivity() {
    override fun attachBaseContext(newBase: android.content.Context) {
        super.attachBaseContext(com.yasha.assist.core.net.AppLocale.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(
            Intent(this, com.yasha.assist.feature.assist.FloatyActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        finish()
    }
}
