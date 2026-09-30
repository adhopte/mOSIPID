package expo.modules.mosipidcapture

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.os.SystemClock
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

/**
 * Active liveness with ML Kit face detection – a direct port of the reference app's analyzer: the user blinks and turns
 * the head both ways in a random order, then looks straight at the camera. One frame per pose is kept; the issuer
 * re-checks that the frames show the same person and that the head really turned (YuNet landmarks + SFace).
 *
 * Not a certified presentation-attack-detection (ISO/IEC 30107-3); a video replay could defeat it.
 */
class LivenessAnalyzer(
  private val context: Context,
  private val onUi: (JSONObject) -> Unit,
  private val onComplete: (JSONObject) -> Unit,
  private val onFrame: () -> Unit = {},
) : ImageAnalysis.Analyzer {

  private enum class Step { CENTER, BLINK, TURN, TURN_OTHER, DONE }

  private val detector = FaceDetection.getClient(
    FaceDetectorOptions.Builder()
      .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST)
      .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
      .setMinFaceSize(0.25f)
      .build()
  )

  // random order of blink / head-turn challenges; the frontal selfie is taken last
  private val steps: List<Step> = run {
    val middle = if (Math.random() < 0.5) listOf(Step.BLINK, Step.TURN, Step.TURN_OTHER) else listOf(Step.TURN, Step.TURN_OTHER, Step.BLINK)
    middle + Step.CENTER
  }
  private var index = 0
  private var stable = 0
  private var eyesWereOpen = false
  private var eyesClosedSeen = false
  private var firstTurnYaw = 0f
  private var turnA: Pair<Float, String>? = null
  private var turnB: Pair<Float, String>? = null
  private val started = SystemClock.elapsedRealtime()
  @Volatile private var finished = false

  @androidx.annotation.OptIn(ExperimentalGetImage::class)
  override fun analyze(proxy: ImageProxy) {
    onFrame()
    val media = proxy.image
    if (finished || media == null) { proxy.close(); return }
    val input = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
    detector.process(input)
      .addOnSuccessListener { faces -> handle(faces, proxy, input.width, input.height) }
      .addOnCompleteListener { proxy.close() }
  }

  private fun ui(step: Step, hint: String?, ok: Boolean) {
    if (!ok) stable = 0
    onUi(JSONObject().put("step", step.name.lowercase()).put("hint", hint ?: JSONObject.NULL).put("faceOk", ok).put("completed", index).put("total", steps.size))
  }

  private fun handle(faces: List<Face>, proxy: ImageProxy, width: Int, height: Int) {
    if (finished) return
    val step = steps[index]
    if (faces.isEmpty()) return ui(step, "no_face", false)
    if (faces.size > 1) return ui(step, "multiple_faces", false)
    val face = faces[0]
    val frameWidth = minOf(width, height).toFloat()
    if (face.boundingBox.width() < 0.28f * frameWidth) return ui(step, "closer", false)
    val yaw = face.headEulerAngleY
    val roll = face.headEulerAngleZ
    val left = face.leftEyeOpenProbability ?: 1f
    val right = face.rightEyeOpenProbability ?: 1f
    when (step) {
      Step.CENTER -> {
        if (abs(yaw) > 10 || abs(roll) > 12) return ui(step, "straight", false)
        if (left < 0.6f || right < 0.6f) return ui(step, "eyes_open", false)
        if (++stable < 4) return ui(step, "hold", true)
        val selfie = saveFrame(proxy)
        advance()
        finish(selfie)
      }
      Step.BLINK -> {
        if (left > 0.7f && right > 0.7f) {
          if (eyesClosedSeen) { advance(); return ui(steps[index], null, true) }
          eyesWereOpen = true
        } else if (eyesWereOpen && left < 0.25f && right < 0.25f) eyesClosedSeen = true
        ui(step, null, true)
      }
      Step.TURN -> {
        if (abs(yaw) < TURN_DEGREES) { stable = 0; return ui(step, null, true) }
        if (++stable < 2) return ui(step, "hold_there", true)
        firstTurnYaw = yaw
        turnA = yaw to saveFrame(proxy)
        advance()
        ui(steps[index], null, true)
      }
      Step.TURN_OTHER -> {
        if (abs(yaw) < TURN_DEGREES || yaw * firstTurnYaw > 0) { stable = 0; return ui(step, null, true) }
        if (++stable < 2) return ui(step, "hold_there", true)
        turnB = yaw to saveFrame(proxy)
        advance()
        ui(steps[index], null, true)
      }
      Step.DONE -> Unit
    }
  }

  private fun advance() { stable = 0; if (index < steps.lastIndex) index++ }

  private fun finish(selfie: String) {
    val a = turnA ?: return
    val b = turnB ?: return
    finished = true
    // ML Kit: positive Euler Y = face turned towards the right of the (unmirrored) image
    val (pos, neg) = if (a.first > 0) a to b else b to a
    onUi(JSONObject().put("step", "done").put("hint", JSONObject.NULL).put("faceOk", true).put("completed", steps.size).put("total", steps.size))
    onComplete(
      JSONObject()
        .put("selfie", selfie).put("turnLeft", pos.second).put("turnRight", neg.second)
        .put("report", JSONObject()
          .put("method", "mlkit_face_active_challenge")
          .put("challenges", JSONArray(steps.map { it.name.lowercase() }))
          .put("blink_detected", eyesClosedSeen)
          .put("yaw_turn_left_deg", pos.first.toDouble())
          .put("yaw_turn_right_deg", neg.first.toDouble())
          .put("duration_ms", SystemClock.elapsedRealtime() - started))
    )
    detector.close()
  }

  fun close() { finished = true; runCatching { detector.close() } }

  /** Rotate the camera frame upright, cap it at 720 px and store it as a JPEG in the cache. */
  private fun saveFrame(proxy: ImageProxy): String {
    var bmp = proxy.toBitmap()
    val rotation = proxy.imageInfo.rotationDegrees
    val scale = 720f / maxOf(bmp.width, bmp.height)
    val m = Matrix().apply {
      if (rotation != 0) postRotate(rotation.toFloat())
      if (scale < 1f) postScale(scale, scale)
    }
    bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
    return ImageTools.saveJpeg(context, bmp, 88)
  }

  private companion object { const val TURN_DEGREES = 22f }
}
