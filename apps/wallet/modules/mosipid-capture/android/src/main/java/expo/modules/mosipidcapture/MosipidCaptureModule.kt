package expo.modules.mosipidcapture

import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.google.android.gms.tasks.Tasks
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MosipidCaptureModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("MosipidCapture")

    /** On-device OCR (ML Kit) of any image file/URI. */
    AsyncFunction("recognizeText") { uri: String ->
      try {
        val bmp = ImageTools.decodeUpright(ImageTools.readBytes(context, uri))
        val text = Tasks.await(TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).process(InputImage.fromBitmap(bmp, 0)))
        ImageTools.textResult(text, bmp.width, bmp.height)
      } catch (e: Exception) { throw CodedException("ERR_OCR", e.message, e) }
    }

    /** Gallery / file-picker image -> upright JPEG (max side in px). */
    AsyncFunction("normalizeImage") { uri: String, maxSide: Int ->
      try { ImageTools.normalize(context, uri, maxSide) } catch (e: Exception) { throw CodedException("ERR_IMAGE", e.message, e) }
    }

    /** PDF -> page images. */
    AsyncFunction("renderPdf") { uri: String, maxPages: Int ->
      try { ImageTools.renderPdf(context, uri, maxPages) } catch (e: Exception) { throw CodedException("ERR_PDF", e.message, e) }
    }

    AsyncFunction("readBase64") { uri: String ->
      try { ImageTools.base64(context, uri) } catch (e: Exception) { throw CodedException("ERR_READ", e.message, e) }
    }

    View(CaptureCameraView::class) {
      Events("onFrameText", "onCaptured", "onLiveness", "onLivenessComplete", "onCaptureError")

      /** "mrz" = back camera, streams OCR frames + takes stills; "liveness" = front camera, blink/turn challenge */
      Prop("mode") { view: CaptureCameraView, mode: String -> view.mode = mode }
      Prop("active") { view: CaptureCameraView, active: Boolean -> view.active = active }
      Prop("captureNonce") { view: CaptureCameraView, n: Int -> view.captureNonce = n }

      OnViewDidUpdateProps { view: CaptureCameraView -> view.applyProps() }
      OnViewDestroys { view: CaptureCameraView -> view.shutdown() }
    }
  }
}
