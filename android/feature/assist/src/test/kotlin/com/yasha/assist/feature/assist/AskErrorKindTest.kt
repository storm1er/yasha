package com.yasha.assist.feature.assist

import org.junit.Assert.assertEquals
import org.junit.Test

// Issue #66: the answer card must distinguish the collapse-everything
// transport code ("network") and a revoked session ("unauthorized") from the
// genuinely unknown failures that keep the generic copy.

class AskErrorKindTest {
    @Test
    fun `network and unauthorized map to their own kinds`() {
        assertEquals(AskErrorKind.Network, askErrorKind("network"))
        assertEquals(AskErrorKind.Unauthorized, askErrorKind("unauthorized"))
    }

    @Test
    fun `every other server code keeps the generic kind`() {
        assertEquals(AskErrorKind.Generic, askErrorKind("timeout"))
        assertEquals(AskErrorKind.Generic, askErrorKind("no_model_configured"))
        assertEquals(AskErrorKind.Generic, askErrorKind("busy"))
        assertEquals(AskErrorKind.Generic, askErrorKind("http_500"))
        assertEquals(AskErrorKind.Generic, askErrorKind(""))
    }
}
