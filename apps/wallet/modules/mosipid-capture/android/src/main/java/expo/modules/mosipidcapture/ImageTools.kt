package expo.modules.mosipidcapture

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import com.google.mlkit.vision.text.Text
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.UUID

/** Image / PDF helpers (ported from the reference app's DocumentOcr + DocumentPdf). */
object ImageTools {
  private const val MAX_BYTES = 25L * 1024 * 1024

  fun toUri(s: String): Uri = if (s.startsWith("/")) Uri.fromFile(File(s)) else Uri.parse(s)

  private fun open(context: Context, uri: String): InputStream =
    context.contentResolver.openInputStream(toUri(uri)) ?: throw IllegalArgumentException("Could not open the selected file")

  fun readBytes(context: Context, uri: String): ByteArray = open(context, uri).use { input ->
    val out = ByteArrayOutputStream()
    val chunk = ByteArray(64 * 1024)
    while (true) {
      val n = input.read(chunk)
      if (n < 0) break
      out.write(chunk, 0, n)
      require(out.size() <= MAX_BYTES) { "File is larger than 25 MB" }
    }
    out.toByteArray()
  }

  /** Decode a JPEG/PNG/WebP/HEIC, apply its EXIF orientation, and down-sample very large photos while decoding. */
  fun decodeUpright(bytes: ByteArray, maxSide: Int = 4096): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
      ?: throw IllegalArgumentException("Unsupported image format")
    val orientation = runCatching {
      ExifInterface(bytes.inputStream()).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
    val rotation = when (orientation) {
      ExifInterface.ORIENTATION_ROTATE_90 -> 90f
      ExifInterface.ORIENTATION_ROTATE_180 -> 180f
      ExifInterface.ORIENTATION_ROTATE_270 -> 270f
      else -> 0f
    }
    if (rotation == 0f) return bmp
    return Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(rotation) }, true)
  }

  fun saveJpeg(context: Context, bmp: Bitmap, quality: Int = 90): String {
    val f = File(context.cacheDir, "mosipid-${UUID.randomUUID()}.jpg")
    f.outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, quality, it) }
    return Uri.fromFile(f).toString()
  }

  fun scaled(bmp: Bitmap, maxSide: Int): Bitmap {
    val scale = maxSide.toFloat() / maxOf(bmp.width, bmp.height)
    return if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true) else bmp
  }

  /** Picked image -> upright JPEG (<= maxSide) in the app cache. */
  fun normalize(context: Context, uri: String, maxSide: Int): Map<String, Any> {
    val bytes = readBytes(context, uri)
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Unsupported image format" }
    require(minOf(bounds.outWidth, bounds.outHeight) >= 600) { "Image is too small (${bounds.outWidth}x${bounds.outHeight}); use at least 600 px on the short side" }
    val bmp = scaled(decodeUpright(bytes), maxSide)
    return mapOf("uri" to saveJpeg(context, bmp, 92), "width" to bmp.width, "height" to bmp.height)
  }

  /** PDF -> up to [maxPages] page images (300 DPI, capped at 3000 px) using the platform PdfRenderer. */
  fun renderPdf(context: Context, uri: String, maxPages: Int): List<Map<String, Any>> {
    val tmp = File.createTempFile("upload", ".pdf", context.cacheDir)
    try {
      open(context, uri).use { input -> tmp.outputStream().use { out -> require(input.copyTo(out) <= MAX_BYTES) { "PDF is larger than 25 MB" } } }
      val fd = ParcelFileDescriptor.open(tmp, ParcelFileDescriptor.MODE_READ_ONLY)
      val renderer = try { PdfRenderer(fd) } catch (e: SecurityException) {
        fd.close(); throw IllegalArgumentException("The PDF is password-protected; remove the password and try again")
      } catch (e: Exception) { fd.close(); throw IllegalArgumentException("Not a readable PDF file") }
      renderer.use { pdf ->
        require(pdf.pageCount > 0) { "The PDF has no pages" }
        return (0 until minOf(pdf.pageCount, maxPages)).map { index ->
          pdf.openPage(index).use { page ->
            var scale = 300f / 72f
            val longest = maxOf(page.width, page.height) * scale
            if (longest > 3000) scale *= 3000 / longest
            val w = (page.width * scale).toInt().coerceAtLeast(1)
            val h = (page.height * scale).toInt().coerceAtLeast(1)
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(Color.WHITE)
            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
            val saved = saveJpeg(context, bitmap, 92)
            val r = mapOf<String, Any>("uri" to saved, "width" to w, "height" to h)
            bitmap.recycle()
            r
          }
        }
      }
    } finally { tmp.delete() }
  }

  fun base64(context: Context, uri: String): String = Base64.encodeToString(readBytes(context, uri), Base64.NO_WRAP)

  /** ML Kit result -> plain map with per-line boxes in upright-image pixels. */
  fun textResult(t: Text, width: Int, height: Int): Map<String, Any> {
    val lines = t.textBlocks.flatMap { it.lines }.mapNotNull { l ->
      l.boundingBox?.let { mapOf("text" to l.text, "left" to it.left, "top" to it.top, "right" to it.right, "bottom" to it.bottom) }
    }
    return mapOf("text" to t.text, "lines" to lines, "width" to width, "height" to height)
  }
}
