package com.yasha.assist.feature.chat

import android.graphics.Paint
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.yasha.assist.core.design.LocalYashaPalette
import com.yasha.assist.core.net.GenUiNode

// Tier-1 generative UI renderer (issue #30; web parity with
// components/chat/gen-ui.tsx): draws a validated render_ui tree. The server
// bounded every string and the tree shape, so this renders trustingly;
// unknown node kinds never arrive (the parser skips them). Charts are static
// Canvas draws — no animation, ANR-safe per the app's stream-UI rules.

private val CHART_COLORS = listOf(
    0xFF3B82F6, 0xFF10B981, 0xFFF59E0B, 0xFFEF4444, 0xFF8B5CF6, 0xFF06B6D4, 0xFFEC4899,
).map { Color(it) }

private fun fmt(v: Float): String =
    if (v == v.toLong().toFloat()) v.toLong().toString() else v.toString().take(6)

@Composable
fun GenUiCard(nodes: List<GenUiNode>) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        nodes.forEach { GenUiNodeView(it) }
    }
}

@Composable
fun GenUiNodeView(node: GenUiNode) {
    val typo = MaterialTheme.typography
    val palette = LocalYashaPalette.current
    when (node) {
        is GenUiNode.Text -> Text(node.text, style = typo.bodySmall)
        is GenUiNode.Metric -> Column {
            Text(
                node.label.uppercase(),
                style = typo.labelSmall,
                color = palette.disclaimer,
                letterSpacing = 0.5.sp,
            )
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(node.value, style = typo.headlineSmall, fontWeight = FontWeight.SemiBold)
                node.unit?.let {
                    Spacer(Modifier.width(4.dp))
                    Text(it, style = typo.bodySmall, color = palette.disclaimer)
                }
                when (node.trend) {
                    "up" -> Text(" ↗", color = Color(0xFF10B981), style = typo.titleMedium)
                    "down" -> Text(" ↘", color = Color(0xFFEF4444), style = typo.titleMedium)
                    "flat" -> Text(" →", color = palette.iconGray, style = typo.titleMedium)
                    else -> Unit
                }
            }
        }
        is GenUiNode.Badge -> {
            val (bg, fg) = when (node.tone) {
                "success" -> Color(0x2610B981) to Color(0xFF059669)
                "warning" -> Color(0x26F59E0B) to Color(0xFFB45309)
                "danger" -> Color(0x26EF4444) to Color(0xFFDC2626)
                "info" -> Color(0x260EA5E9) to Color(0xFF0284C7)
                else -> MaterialTheme.colorScheme.surfaceVariant to palette.disclaimer
            }
            Box(
                Modifier
                    .clip(CircleShape)
                    .background(bg)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            ) {
                Text(node.text, style = typo.labelSmall, color = fg, fontWeight = FontWeight.Medium)
            }
        }
        is GenUiNode.Progress -> Column {
            val label = node.label
            if (label != null) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(label, style = typo.labelSmall, color = palette.disclaimer)
                    Text("${fmt(node.value)}%", style = typo.labelSmall, color = palette.disclaimer)
                }
                Spacer(Modifier.height(4.dp))
            }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(6.dp)
                    .clip(RoundedCornerShape(3.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(node.value / 100f)
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(3.dp))
                        .background(MaterialTheme.colorScheme.primary),
                )
            }
        }
        is GenUiNode.BulletList -> Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            node.items.forEachIndexed { i, item ->
                Text(if (node.ordered) "${i + 1}.  $item" else "•  $item", style = typo.bodySmall)
            }
        }
        is GenUiNode.Table -> GenUiTableView(node)
        is GenUiNode.Chart -> GenUiChartView(node)
        is GenUiNode.Card -> Column(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(14.dp))
                .border(1.dp, palette.composerOutline, RoundedCornerShape(14.dp))
                .background(MaterialTheme.colorScheme.surface)
                .padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            node.title?.let { Text(it, style = typo.titleSmall) }
            node.children.forEach { GenUiNodeView(it) }
        }
        is GenUiNode.Grid -> Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            node.children.chunked(node.cols).forEach { rowKids ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    rowKids.forEach { kid ->
                        Box(Modifier.weight(1f)) { GenUiNodeView(kid) }
                    }
                    repeat(node.cols - rowKids.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
        is GenUiNode.Slides -> GenUiSlidesView(node)
    }
}

// Cells share the width up to 4 columns; wider tables scroll horizontally.
@Composable
private fun RowScope.TableCell(wide: Boolean, index: Int, content: @Composable () -> Unit) {
    if (wide) Box(Modifier.width(110.dp)) { content() }
    else Box(Modifier.weight(if (index == 0) 1.2f else 1f)) { content() }
}

@Composable
private fun GenUiTableView(node: GenUiNode.Table) {
    val typo = MaterialTheme.typography
    val palette = LocalYashaPalette.current
    val scroll = rememberScrollState()
    val wide = node.columns.size > 4
    Column(
        Modifier
            .fillMaxWidth()
            .then(if (wide) Modifier.horizontalScroll(scroll) else Modifier),
    ) {
        Row(Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
            node.columns.forEachIndexed { i, c ->
                TableCell(wide, i) {
                    Text(
                        c,
                        style = typo.labelSmall,
                        color = palette.disclaimer,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.padding(end = 6.dp),
                    )
                }
            }
        }
        node.rows.forEach { row ->
            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
                node.columns.indices.forEach { i ->
                    TableCell(wide, i) {
                        Text(
                            row.getOrElse(i) { "" },
                            style = typo.bodySmall,
                            modifier = Modifier.padding(end = 6.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun GenUiChartView(node: GenUiNode.Chart) {
    val typo = MaterialTheme.typography
    val palette = LocalYashaPalette.current
    Column(Modifier.fillMaxWidth()) {
        if (node.title != null || node.unit != null) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(node.title ?: "", style = typo.labelMedium)
                node.unit?.let { Text(it, style = typo.labelSmall, color = palette.disclaimer) }
            }
            Spacer(Modifier.height(6.dp))
        }
        if (node.chart == "donut") {
            Row(verticalAlignment = Alignment.CenterVertically) {
                DonutCanvas(node, Modifier.weight(1f).height(130.dp))
                Spacer(Modifier.width(10.dp))
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    node.data.forEachIndexed { i, p ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier
                                    .size(8.dp)
                                    .clip(CircleShape)
                                    .background(CHART_COLORS[i % CHART_COLORS.size]),
                            )
                            Spacer(Modifier.width(5.dp))
                            Text(p.label, style = typo.labelSmall, maxLines = 1)
                        }
                    }
                }
            }
        } else {
            AxisCanvas(node, Modifier.fillMaxWidth().height(150.dp))
        }
    }
}

@Composable
private fun AxisCanvas(node: GenUiNode.Chart, modifier: Modifier = Modifier) {
    val palette = LocalYashaPalette.current
    val gridColor = palette.composerOutline
    val line = MaterialTheme.colorScheme.primary
    val chart = node.chart
    androidx.compose.foundation.Canvas(modifier) {
        val n = node.data.size
        if (n == 0) return@Canvas
        val maxV = (node.data.maxOf { it.value }.coerceAtLeast(0f) * 1.15f).let { if (it == 0f) 1f else it }
        val plotH = size.height - 22.dp.toPx()
        val slot = size.width / n
        listOf(0f, 0.5f, 1f).forEach { f ->
            val y = plotH - plotH * f
            drawLine(gridColor, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
        }
        val labelPaint = Paint().apply {
            isAntiAlias = true
            color = android.graphics.Color.argb(180, 128, 128, 128)
            textSize = 22f
            textAlign = Paint.Align.CENTER
        }
        val stride = maxOf(1, kotlin.math.ceil(n / 6f).toInt())
        if (chart == "bar") {
            node.data.forEachIndexed { i, p ->
                val h = (p.value / maxV) * plotH
                drawRect(
                    color = line,
                    topLeft = Offset(i * slot + slot * 0.22f, plotH - h),
                    size = Size(slot * 0.56f, h),
                )
                if (i % stride == 0) {
                    drawContext.canvas.nativeCanvas.drawText(ellipsize(p.label), i * slot + slot / 2f, size.height - 4f, labelPaint)
                }
            }
        } else {
            val path = Path()
            node.data.forEachIndexed { i, p ->
                val x = i * slot + slot / 2f
                val y = plotH - (p.value / maxV) * plotH
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
            }
            if (chart == "area") {
                path.lineTo((n - 1) * slot + slot / 2f, plotH)
                path.lineTo(slot / 2f, plotH)
                path.close()
                drawPath(path, line.copy(alpha = 0.15f))
            } else {
                drawPath(path, line, style = Stroke(width = 3.dp.toPx()))
            }
            node.data.forEachIndexed { i, p ->
                if (i % stride == 0) {
                    drawContext.canvas.nativeCanvas.drawText(ellipsize(p.label), i * slot + slot / 2f, size.height - 4f, labelPaint)
                }
            }
        }
    }
}

@Composable
private fun DonutCanvas(node: GenUiNode.Chart, modifier: Modifier = Modifier) {
    val total = node.data.sumOf { it.value.toDouble() }.toFloat()
    val hole = MaterialTheme.colorScheme.surface
    androidx.compose.foundation.Canvas(modifier) {
        if (total <= 0f) return@Canvas
        var start = -90f
        node.data.forEachIndexed { i, p ->
            val sweep = (p.value / total) * 360f
            drawArc(
                color = CHART_COLORS[i % CHART_COLORS.size],
                startAngle = start,
                sweepAngle = sweep,
                useCenter = true,
            )
            start += sweep
        }
        drawCircle(hole, radius = size.minDimension * 0.28f, center = center)
    }
}

private fun ellipsize(s: String): String = if (s.length > 7) s.take(6) + "…" else s

@Composable
private fun GenUiSlidesView(node: GenUiNode.Slides) {
    val typo = MaterialTheme.typography
    val palette = LocalYashaPalette.current
    var index by remember(node) { mutableIntStateOf(0) }
    val idx = index.coerceIn(0, node.slides.lastIndex)
    val slide = node.slides[idx]
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Column(Modifier.fillMaxWidth()) {
            slide.title?.let { Text(it, style = typo.titleSmall) }
            slide.body?.let {
                Spacer(Modifier.height(2.dp))
                Text(it, style = typo.bodySmall, color = palette.disclaimer)
            }
            if (slide.children.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                slide.children.forEach { GenUiNodeView(it) }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            SlideButton("‹", stringResource(R.string.gen_ui_prev), enabled = idx > 0) { index = idx - 1 }
            SlideButton("›", stringResource(R.string.gen_ui_next), enabled = idx < node.slides.lastIndex) { index = idx + 1 }
            Text("${idx + 1}/${node.slides.size}", style = typo.labelSmall, color = palette.disclaimer)
        }
    }
}

@Composable
private fun SlideButton(glyph: String, label: String, enabled: Boolean, onClick: () -> Unit) {
    val palette = LocalYashaPalette.current
    Box(
        Modifier
            .size(30.dp)
            .clip(RoundedCornerShape(8.dp))
            .border(1.dp, palette.composerOutline, RoundedCornerShape(8.dp))
            .semantics { contentDescription = label }
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            glyph,
            style = MaterialTheme.typography.titleMedium,
            color = if (enabled) MaterialTheme.colorScheme.onSurface else palette.iconGray,
            modifier = Modifier.padding(bottom = 2.dp),
        )
    }
}
