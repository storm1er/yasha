package com.yasha.assist.core.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppLocaleTest {
    @Test
    fun `resolve - account value wins, unknown or null falls back to the static default`() {
        assertEquals("en", AppLocale.resolve("en"))
        assertEquals("fr", AppLocale.resolve("fr"))
        assertEquals("en", AppLocale.resolve(null))
        assertEquals("en", AppLocale.resolve("de"))
        assertEquals("en", AppLocale.resolve(""))
    }

    @Test
    fun `default tag is en (never the device locale)`() {
        assertEquals("en", AppLocale.DEFAULT_TAG)
        assertEquals(listOf("en", "fr"), AppLocale.SUPPORTED)
    }

    @Test
    fun `localeFromMeJson parses user locale`() {
        assertEquals(
            "fr",
            AppLocale.localeFromMeJson("""{"user":{"id":"u1","username":"a","email":"e","role":"user","locale":"fr"}}"""),
        )
        assertNull(AppLocale.localeFromMeJson("""{"user":{"id":"u1","locale":null}}"""))
        assertNull(AppLocale.localeFromMeJson("""{"user":{"id":"u1"}}"""))
        assertNull(AppLocale.localeFromMeJson("""{"nope":1}"""))
        assertNull(AppLocale.localeFromMeJson("not json at all"))
    }
}
