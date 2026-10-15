package com.yasha.assist

import android.content.Intent
import android.service.quicksettings.TileService

// Fallback trigger #1 (no assistant role needed): quick-settings tile.
class AssistTileService : TileService() {
    override fun onClick() {
        startActivity(
            Intent(this, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_ASSIST, System.currentTimeMillis())
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
