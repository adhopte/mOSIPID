package expo.modules.mosipidcapture

import android.annotation.SuppressLint
import android.content.Context
import android.util.Size
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCase
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Every event carries one JSON string – keeps the native/JS bridge trivial. */
class JsonEvent(@Field val json: String = "") : Record

/**
 * CameraX preview with two modes (ported from the reference app's CameraPreview + analyzers):
 *  - "mrz": back camera. Streams ML Kit OCR of the live frames (`onFrameText`) so JS can decide when a valid MRZ is steady,
 *    and takes a full-resolution still (+ OCR of it) when `captureNonce` changes (`onCaptured`).
 *  - "liveness": front camera. Runs the blink / head-turn challenge (`onLiveness`, `onLivenessComplete`).
 */
@SuppressLint("ViewConstructor")
class CaptureCameraView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onFrameText by EventDispatcher<JsonEvent>()
  private val onCaptured by EventDispatcher<JsonEvent>()
  private val onLiveness by EventDispatcher<JsonEvent>()
  private val onLivenessComplete by EventDispatcher<JsonEvent>()
  private val onCaptureError by EventDispatcher<JsonEvent>()

  var mode: String = "mrz"
  var active: Boolean = false
  var captureNonce: Int = 0

  private var boundMode: String? = null
  private var boundActive = false
  private var lastNonce = 0
  private var provider: ProcessCameraProvider? = null
  private var imageCapture: ImageCapture? = null
  private var liveness: LivenessAnalyzer? = null
  private val analysisExecutor = Executors.newSingleThreadExecutor()
  private val ioExecutor = Executors.newSingleThreadExecutor()
  private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }

  init { addView(previewView) }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    previewView.layout(0, 0, right - left, bottom - top)
  }

  fun applyProps() {
    if (active && (!boundActive || boundMode != mode)) bind()
    else if (!active && boundActive) unbind()
    if (captureNonce != lastNonce) {
      lastNonce = captureNonce
      if (active && mode == "mrz") takeStill()
    }
  }

  private fun error(message: String?) = onCaptureError(JsonEvent(JSONObject().put("message", message ?: "camera error").toString()))

  private fun bind() {
    val activity = appContext.currentActivity as? AppCompatActivity ?: return error("no activity")
    boundMode = mode
    boundActive = true
    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      try {
        val p = future.get()
        provider = p
        p.unbindAll()
        liveness?.close(); liveness = null; imageCapture = null
        val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
        val analysis = ImageAnalysis.Builder()
          .setResolutionSelector(
            ResolutionSelector.Builder()
              .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
              .build()
          )
          .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
          .build()
        val cases = mutableListOf<UseCase>(preview, analysis)
        val selector: CameraSelector
        if (mode == "liveness") {
          selector = CameraSelector.DEFAULT_FRONT_CAMERA
          val a = LivenessAnalyzer(
            context,
            onUi = { onLiveness(JsonEvent(it.toString())) },
            onComplete = { onLivenessComplete(JsonEvent(it.toString())) },
          )
          liveness = a
          analysis.setAnalyzer(analysisExecutor, a)
        } else {
          selector = CameraSelector.DEFAULT_BACK_CAMERA
          analysis.setAnalyzer(analysisExecutor, MrzFrameAnalyzer())
          val cap = ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY).build()
          imageCapture = cap
          cases.add(cap)
        }
        p.bindToLifecycle(activity, selector, *cases.toTypedArray())
      } catch (e: Exception) {
        boundActive = false
        error(e.message)
      }
    }, ContextCompat.getMainExecutor(context))
  }

  private fun unbind() {
    boundActive = false
    boundMode = null
    liveness?.close(); liveness = null
    imageCapture = null
    runCatching { provider?.unbindAll() }
  }

  fun shutdown() {
    unbind()
    analysisExecutor.shutdown()
    ioExecutor.shutdown()
  }

  /** Streams on-device OCR of the preview (~4 fps). JS decides when a valid MRZ has been steady long enough. */
  private inner class MrzFrameAnalyzer : ImageAnalysis.Analyzer {
    private val busy = AtomicBoolean(false)
    private var lastRun = 0L

    @androidx.annotation.OptIn(ExperimentalGetImage::class)
    override fun analyze(image: ImageProxy) {
      val media = image.image
      val now = System.currentTimeMillis()
      if (media == null || now - lastRun < 250 || !busy.compareAndSet(false, true)) { image.close(); return }
      lastRun = now
      val rotation = image.imageInfo.rotationDegrees
      val w = if (rotation % 180 == 0) image.width else image.height
      val h = if (rotation % 180 == 0) image.height else image.width
      recognizer.process(InputImage.fromMediaImage(media, rotation))
        .addOnSuccessListener { onFrameText(JsonEvent(JSONObject(ImageTools.textResult(it, w, h)).toString())) }
        .addOnCompleteListener { busy.set(false); image.close() }
    }
  }

  private fun takeStill() {
    val cap = imageCapture ?: return
    val file = File(context.cacheDir, "doc-${UUID.randomUUID()}.jpg")
    cap.takePicture(
      ImageCapture.OutputFileOptions.Builder(file).build(),
      ContextCompat.getMainExecutor(context),
      object : ImageCapture.OnImageSavedCallback {
        override fun onImageSaved(output: ImageCapture.OutputFileResults) { processStill(file) }
        override fun onError(exception: ImageCaptureException) { error(exception.message) }
      },
    )
  }

  /** Upright, size-capped JPEG of the still + full-resolution OCR text, emitted as `onCaptured`. */
  private fun processStill(file: File) = ioExecutor.execute {
    try {
      val bmp = ImageTools.scaled(ImageTools.decodeUpright(file.readBytes()), 2400)
      val uri = ImageTools.saveJpeg(context, bmp, 92)
      val text = Tasks.await(recognizer.process(InputImage.fromBitmap(bmp, 0)))
      file.delete()
      onCaptured(JsonEvent(JSONObject(ImageTools.textResult(text, bmp.width, bmp.height)).put("uri", uri).toString()))
    } catch (e: Exception) {
      error(e.message)
    }
  }
}
