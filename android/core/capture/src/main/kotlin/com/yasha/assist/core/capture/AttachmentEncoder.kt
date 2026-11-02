package com.yasha.assist.core.capture

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import kotlin.math.roundToInt
import java.io.ByteArrayOutputStream
import java.util.Base64

// Mirror of the web composer pipeline (lib/image-attachment.ts):
// png/jpeg/webp only, ≤20 MB in, downscale longest side to 1568,
// non-PNG flattened on white and re-encoded JPEG q85, data URL ≤ 6 MB chars.
object AttachmentEncoder {
    const val MAX_SIDE = 1568
    const val MAX_FILE_BYTES = 20L * 1024 * 1024
    const val MAX_DATAURL_CHARS = 6_000_000 // server cap, lib/chat-attachments.ts
    private const val JPEG_QUALITY = 85
    private val ACCEPTED = setOf("image/png", "image/jpeg", "image/webp")

    sealed interface Result {
        data class Ok(val dataUrl: String) : Result
        data class Err(val code: String) : Result // "unsupported" | "too_large"
    }

    fun encode(bytes: ByteArray, mime: String?, maxFileBytes: Long = MAX_FILE_BYTES): Result {
        if (mime !in ACCEPTED) return Result.Err("unsupported")
        if (bytes.size > maxFileBytes) return Result.Err("too_large")
        return try {
            // ByteBuffer overload: API 28+ (the ByteArray overload is API 31, above minSdk 30).
            val source = ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes))
            val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                val longest = maxOf(info.size.width, info.size.height)
                if (longest > MAX_SIDE) {
                    val scale = MAX_SIDE.toFloat() / longest
                    decoder.setTargetSize(
                        (info.size.width * scale).roundToInt().coerceAtLeast(1),
                        (info.size.height * scale).roundToInt().coerceAtLeast(1),
                    )
                }
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
            encodeBitmap(bitmap, asPng = mime == "image/png")
        } catch (_: Exception) {
            Result.Err("unsupported")
        }
    }

    /** Crop a captured screen region (fractional rect) and encode as a JPEG data URL. */
    fun encodeCrop(source: Bitmap, rect: RectFrac): Result {
        val px = CropMath.toPixels(rect, source.width, source.height)
        return try {
            val cropped = Bitmap.createBitmap(source, px.left, px.top, px.width, px.height)
            encodeBitmap(cropped, asPng = false)
        } catch (_: Exception) {
            Result.Err("unsupported")
        }
    }

    /** Downscale-to-1568 + JPEG/PNG re-encode + data URL caps for an in-memory bitmap. */
    fun encodeBitmap(bitmap: Bitmap, asPng: Boolean): Result {
        return try {
            val scaled = scaleToMaxSide(bitmap)
            val flat = if (asPng || !scaled.hasAlpha()) {
                scaled
            } else {
                // JPEG has no alpha: flatten like the canvas fill in the web version.
                Bitmap.createBitmap(scaled.width, scaled.height, Bitmap.Config.ARGB_8888).also { f ->
                    val c = Canvas(f)
                    c.drawColor(Color.WHITE)
                    c.drawBitmap(scaled, 0f, 0f, null)
                }
            }
            val out = ByteArrayOutputStream()
            if (asPng) flat.compress(Bitmap.CompressFormat.PNG, 100, out)
            else flat.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)
            val mime = if (asPng) "image/png" else "image/jpeg"
            val dataUrl = "data:$mime;base64," + Base64.getEncoder().encodeToString(out.toByteArray())
            if (dataUrl.length > MAX_DATAURL_CHARS) Result.Err("too_large") else Result.Ok(dataUrl)
        } catch (_: Exception) {
            Result.Err("unsupported")
        }
    }

    private fun scaleToMaxSide(bitmap: Bitmap): Bitmap {
        val longest = maxOf(bitmap.width, bitmap.height)
        if (longest <= MAX_SIDE) return bitmap
        val scale = MAX_SIDE.toFloat() / longest
        return Bitmap.createScaledBitmap(
            bitmap,
            (bitmap.width * scale).roundToInt().coerceAtLeast(1),
            (bitmap.height * scale).roundToInt().coerceAtLeast(1),
            true,
        )
    }
}
