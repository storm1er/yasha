package com.yasha.assist.core.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull

// Tier-1 generative UI (issue #30; server lib/chat/render-ui.ts): the
// model's declarative component tree, delivered live as the `data-card`
// chunk and persisted on `meta.cards`. The server validates the shape and
// caps, so parsing here is trust-but-skip: a malformed node degrades to
// null (skipped) instead of failing the whole card.
sealed interface GenUiNode {
    data class Text(val text: String) : GenUiNode
    data class Metric(val label: String, val value: String, val unit: String?, val trend: String?) : GenUiNode
    data class Badge(val text: String, val tone: String) : GenUiNode
    data class Progress(val label: String?, val value: Float) : GenUiNode
    data class BulletList(val items: List<String>, val ordered: Boolean) : GenUiNode
    data class Chart(val chart: String, val title: String?, val unit: String?, val data: List<Point>) : GenUiNode {
        data class Point(val label: String, val value: Float)
    }

    data class Table(val columns: List<String>, val rows: List<List<String>>) : GenUiNode
    data class Card(val title: String?, val children: List<GenUiNode>) : GenUiNode
    data class Grid(val cols: Int, val children: List<GenUiNode>) : GenUiNode
    data class Slides(val slides: List<Slide>) : GenUiNode

    data class Slide(val title: String?, val body: String?, val children: List<GenUiNode>)
}

object GenUiParser {
    /** `root` is one node or an array of stacked nodes (web parity). */
    fun parseRoot(el: JsonElement?): List<GenUiNode> {
        val items = when (el) {
            is JsonArray -> el.toList()
            is JsonObject -> listOf(el)
            else -> return emptyList()
        }
        return items.mapNotNull { parseNode(it) }
    }

    fun parseNode(el: JsonElement?): GenUiNode? {
        val o = el as? JsonObject ?: return null
        fun children(): List<GenUiNode> =
            ((o["children"] as? JsonArray) ?: JsonArray(emptyList())).mapNotNull { parseNode(it) }
        fun str(key: String): String? = o[key]?.jsonPrimitive?.contentOrNull
        return when (str("type")) {
            "text" -> str("text")?.let { GenUiNode.Text(it) }
            "metric" -> {
                val label = str("label") ?: return null
                val value = str("value") ?: return null
                GenUiNode.Metric(label, value, str("unit"), str("trend"))
            }
            "badge" -> str("text")?.let { GenUiNode.Badge(it, str("tone") ?: "default") }
            "progress" -> {
                val v = o["value"]?.jsonPrimitive?.doubleOrNull ?: return null
                GenUiNode.Progress(str("label"), v.toFloat().coerceIn(0f, 100f))
            }
            "list" -> {
                val items = (o["items"] as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull }
                    ?: return null
                if (items.isEmpty()) null else GenUiNode.BulletList(items, o["ordered"]?.jsonPrimitive?.contentOrNull == "true")
            }
            "chart" -> {
                val kind = str("chart") ?: return null
                val points = (o["data"] as? JsonArray)?.mapNotNull { p ->
                    val po = p as? JsonObject ?: return@mapNotNull null
                    val label = po["label"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                    val value = po["value"]?.jsonPrimitive?.doubleOrNull ?: return@mapNotNull null
                    GenUiNode.Chart.Point(label, value.toFloat())
                }.orEmpty()
                if (points.isEmpty()) null else GenUiNode.Chart(kind, str("title"), str("unit"), points)
            }
            "table" -> {
                val cols = (o["columns"] as? JsonArray)?.map { it.jsonPrimitive.contentOrNull ?: "" }
                    ?: return null
                if (cols.isEmpty()) return null
                val rows = (o["rows"] as? JsonArray)?.map { row ->
                    (row as? JsonArray)?.map { it.jsonPrimitive.contentOrNull ?: "" }.orEmpty()
                }.orEmpty()
                GenUiNode.Table(cols, rows.filter { it.isNotEmpty() })
            }
            "card" -> {
                val kids = children()
                if (kids.isEmpty()) null else GenUiNode.Card(str("title"), kids)
            }
            "grid" -> {
                val kids = children()
                if (kids.isEmpty()) null else GenUiNode.Grid((o["cols"]?.jsonPrimitive?.doubleOrNull ?: 2.0).toInt().coerceIn(1, 4), kids)
            }
            "slides" -> {
                val slides = (o["slides"] as? JsonArray)?.mapNotNull { s ->
                    val so = s as? JsonObject ?: return@mapNotNull null
                    GenUiNode.Slide(
                        title = so["title"]?.jsonPrimitive?.contentOrNull,
                        body = so["body"]?.jsonPrimitive?.contentOrNull,
                        children = ((so["children"] as? JsonArray) ?: JsonArray(emptyList())).mapNotNull { parseNode(it) },
                    )
                }.orEmpty()
                if (slides.isEmpty()) null else GenUiNode.Slides(slides)
            }
            else -> null
        }
    }
}
