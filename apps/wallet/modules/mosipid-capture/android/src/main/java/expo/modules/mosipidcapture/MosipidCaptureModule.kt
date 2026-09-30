package expo.modules.mosipidcapture

import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MosipidCaptureModule : Module() {
  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val faceDetector by lazy {
    FaceDetection.getClient(
      FaceDetectorOptions.Builder()
        .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
        .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
        .setMinFaceSize(0.25f)
        .build()
    )
  }

  override fun definition() = ModuleDefinition {
    Name("MosipidCapture")

    /** One ML Kit face analysis of a still (used by the expo-camera based liveness). Tries other rotations when no face is found. */
    AsyncFunction("analyseFace") { uri: String, rotation: Int ->
      try {
        val bmp = ImageTools.decodeUpright(ImageTools.readBytes(context, uri), 1024)
        var used = rotation
        var faces = Tasks.await(faceDetector.process(InputImage.fromBitmap(bmp, used)))
        if (faces.isEmpty() && rotation == 0) {
          for (r in intArrayOf(270, 90, 180)) {
            val f = Tasks.await(faceDetector.process(InputImage.fromBitmap(bmp, r)))
            if (f.isNotEmpty()) { faces = f; used = r; break }
          }
        }
        val face = faces.firstOrNull()
        mapOf<String, Any>(
          "faces" to faces.size, "rotation" to used, "frameWidth" to minOf(bmp.width, bmp.height),
          "boxWidth" to (face?.boundingBox?.width() ?: 0),
          "yaw" to (face?.headEulerAngleY ?: 0f).toDouble(), "roll" to (face?.headEulerAngleZ ?: 0f).toDouble(),
          "left" to (face?.leftEyeOpenProbability ?: 1f).toDouble(), "right" to (face?.rightEyeOpenProbability ?: 1f).toDouble(),
        )
      } catch (e: Exception) { throw CodedException("ERR_FACE", e.message, e) }
    }

    /** Upright (EXIF + extra rotation), size-capped JPEG of a still. */
    AsyncFunction("frameToJpeg") { uri: String, rotation: Int, maxSide: Int ->
      try { ImageTools.rotatedJpeg(context, uri, rotation, maxSide) } catch (e: Exception) { throw CodedException("ERR_IMAGE", e.message, e) }
    }

    /** Rotate an image file by 90/180/270 degrees (for scans that were fed in sideways). */
    AsyncFunction("rotateImage") { uri: String, degrees: Int ->
      try { ImageTools.rotatedJpeg(context, uri, degrees, 4096) } catch (e: Exception) { throw CodedException("ERR_IMAGE", e.message, e) }
    }

    /** Crop a fractional region (0..1) of an image and scale it up for OCR. */
    AsyncFunction("cropImage") { uri: String, x: Double, y: Double, w: Double, h: Double, maxSide: Int ->
      try { ImageTools.crop(context, uri, x, y, w, h, maxSide) } catch (e: Exception) { throw CodedException("ERR_IMAGE", e.message, e) }
    }

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
