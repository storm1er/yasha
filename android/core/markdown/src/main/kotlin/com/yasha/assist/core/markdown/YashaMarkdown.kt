package com.yasha.assist.core.markdown

import android.content.ClipData
import android.content.ClipboardManager
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.MarkdownCodeFence
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.DefaultMarkdownColors
import com.mikepenz.markdown.model.MarkdownColors

/**
 * Assistant-message markdown rendering shared by the full-screen chat and the
 * assistant floaty. GFM (tables included) via the JetBrains parser; body text
 * keeps our 17sp/26sp chat metrics; fenced code gets a lang label + copy button
 * (web `code-block.tsx` parity). Links open through `LocalUriHandler`
 * (browser / Custom Tab) — handled by the renderer itself.
 *
 * @param dark Override palette for surfaces without Material theming (the
 * floaty draws over a screenshot: white text, transparent surfaces).
 */
@Composable
fun YashaMarkdown(
    content: String,
    modifier: Modifier = Modifier,
    streaming: Boolean = false,
    dark: Boolean = false,
) {
    val bodyColor = if (dark) Color.White else MaterialTheme.colorScheme.onSurface
    val linkColor = if (dark) Color(0xFF8AB4F8) else MaterialTheme.colorScheme.primary
    val codeSurface = if (dark) Color(0x661E1E20) else MaterialTheme.colorScheme.surfaceVariant
    val codeText = if (dark) Color.White else MaterialTheme.colorScheme.onSurfaceVariant
    val dividerColor = if (dark) Color(0x33FFFFFF) else MaterialTheme.colorScheme.outlineVariant
    val tableBackground = if (dark) Color(0x22FFFFFF) else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)

    val colors: MarkdownColors = if (dark) {
        DefaultMarkdownColors(
            text = bodyColor,
            codeText = codeText,
            inlineCodeText = bodyColor,
            linkText = linkColor,
            codeBackground = Color.Transparent,
            inlineCodeBackground = Color(0x33FFFFFF),
            dividerColor = dividerColor,
            tableText = bodyColor,
            tableBackground = tableBackground,
        )
    } else {
        markdownColor(
            text = bodyColor,
            codeText = codeText,
            inlineCodeText = bodyColor,
            linkText = linkColor,
            codeBackground = Color.Transparent,
            inlineCodeBackground = codeSurface.copy(alpha = 0.6f),
            dividerColor = dividerColor,
            tableText = bodyColor,
            tableBackground = tableBackground,
        )
    }

    val body = MaterialTheme.typography.bodyLarge.copy(fontSize = 17.sp, lineHeight = 26.sp)
    val typography = markdownTypography(
        text = body,
        paragraph = body,
        ordered = body,
        bullet = body,
        list = body,
        code = MaterialTheme.typography.bodyMedium.copy(
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            lineHeight = 20.sp,
        ),
        link = body.copy(color = linkColor),
    )

    val components = markdownComponents(
        codeFence = { model ->
            MarkdownCodeFence(model.content, model.node) { code, lang ->
                YashaCodeBlock(code = code, lang = lang, codeSurface = codeSurface, codeText = codeText, dividerColor = dividerColor)
            }
        },
        codeBlock = { model ->
            MarkdownCodeFence(model.content, model.node) { code, lang ->
                YashaCodeBlock(code = code, lang = lang, codeSurface = codeSurface, codeText = codeText, dividerColor = dividerColor)
            }
        },
    )

    SelectionContainer {
        Markdown(
            content = content + if (streaming) " ▌" else "",
            colors = colors,
            typography = typography,
            modifier = modifier,
            components = components,
        )
    }
}

@Composable
private fun YashaCodeBlock(
    code: String,
    lang: String?,
    codeSurface: Color,
    codeText: Color,
    dividerColor: Color,
) {
    val context = LocalContext.current
    val label = stringResource(R.string.copy_code)
    val copiedMsg = stringResource(R.string.copied_code)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 6.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(codeSurface),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 14.dp, end = 6.dp, top = 2.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                lang?.takeIf { it.isNotBlank() } ?: "code",
                style = MaterialTheme.typography.labelSmall,
                color = codeText.copy(alpha = 0.7f),
            )
            IconButton(
                onClick = {
                    context.getSystemService(ClipboardManager::class.java)
                        ?.setPrimaryClip(ClipData.newPlainText(label, code))
                    Toast.makeText(context, copiedMsg, Toast.LENGTH_SHORT).show()
                },
                modifier = Modifier.size(32.dp),
            ) {
                Icon(
                    painter = painterResource(R.drawable.ic_copy),
                    contentDescription = label,
                    tint = codeText.copy(alpha = 0.8f),
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        Spacer(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp)
                .padding(top = 0.dp)
                .size(1.dp)
                .background(dividerColor),
        )
        Text(
            code,
            style = MaterialTheme.typography.bodyMedium.copy(
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                lineHeight = 20.sp,
            ),
            color = codeText,
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 14.dp, vertical = 10.dp),
        )
    }
}
