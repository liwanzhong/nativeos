package com.nativeos.app.chooser

import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Native share-chooser that fires `Activity.startActivity(Intent.createChooser(...))`
 * and resolves the promise *immediately* — no `startActivityForResult` /
 * `ActivityResultLauncher`, no `onActivityResult` callback. This sidesteps
 * the RN 0.83 + Hermes bug where chooser callbacks never land on some
 * devices / emulators (the same bug that bricks `expo-sharing` and
 * `expo-intent-launcher`).
 *
 * The chooser is a system UI; once it pops the system hands the intent
 * to the target app and we don't need to know the result.
 */
class ChooserModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  companion object {
    private const val TAG = "NativeChooser"
  }

  override fun getName(): String = "NativeChooser"

  @ReactMethod
  fun open(contentUri: String, mimeType: String, title: String, promise: Promise) {
    try {
      // RN 0.83 移除了 ReactContextBaseJavaModule.currentActivity 快捷属性,
      // 改从 reactApplicationContext 拿 (底层就是 ReactContext.getCurrentActivity())。
      val activity = reactApplicationContext.currentActivity
          ?: throw IllegalStateException("No current activity")

      Log.i(TAG, "open() called: uri=$contentUri mime=$mimeType title=$title activity=$activity")

      val uri = Uri.parse(contentUri)

      val sendIntent = Intent(Intent.ACTION_SEND).apply {
        type = mimeType
        putExtra(Intent.EXTRA_STREAM, uri)
        // ClipData 必加:Intent.createChooser 不会把内层 intent 的
        // FLAG_GRANT_READ_URI_PERMISSION 自动传播给被选中的目标 app,
        // 必须通过 clipData 让系统知道要 grant 哪个 URI 给谁。
        clipData = ClipData.newUri(activity.contentResolver, "zip", uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }

      // 关键诊断:在 MuMu / 极简模拟器 / 屏蔽了第三方应用的设备上,可能根本没有
      // app 能处理 application/zip。此时 startActivity 不会抛 ActivityNotFoundException,
      // 而是会"成功返回" — 但 chooser 弹一个空列表,用户看到的就是"啥也没发生"。
      // 提前 queryIntentActivities 拦下来,给用户一个具体提示。
      val pm = activity.packageManager
      val resolved = pm.queryIntentActivities(sendIntent, 0)
      Log.i(TAG, "queryIntentActivities count=${resolved.size}")
      resolved.forEachIndexed { i, info ->
        Log.i(TAG, "  target[$i]: ${info.activityInfo.packageName}/${info.activityInfo.name} label=${info.loadLabel(pm)}")
      }
      if (resolved.isEmpty()) {
        Log.w(TAG, "no apps handle $mimeType — chooser would be empty, abort early")
        promise.reject(
          "E_NO_HANDLER",
          "当前设备没有应用能处理 $mimeType 类型的文件 (MuMu 等精简模拟器上常见)。" +
            "备份文件已保留在 app 私有目录,可用 adb pull 或文件管理器取出。",
        )
        return
      }

      // **不要** addFlags(FLAG_ACTIVITY_NEW_TASK):
      // 我们已经有 Activity context,加 NEW_TASK 会把 chooser 推到独立 task
      // (在 MuMu 等模拟器上经常被推到后台,看起来"没弹窗")。
      // 也不要 addFlags(FLAG_GRANT_READ_URI_PERMISSION) on chooser:
      // grant flag 只对承载 EXTRA_STREAM 的 intent 有意义,chooser 本身不需要。
      val chooserIntent = Intent.createChooser(sendIntent, title)

      Log.i(TAG, "about to startActivity chooser: $chooserIntent")
      activity.startActivity(chooserIntent)
      Log.i(TAG, "startActivity returned OK")

      // Fire-and-forget: the system owns the chooser now. We resolve
      // immediately so the JS promise doesn't hang waiting for an
      // onActivityResult callback that will never come.
      promise.resolve(null)
    } catch (e: Throwable) {
      Log.e(TAG, "open() failed", e)
      promise.reject("E_CHOOSER_OPEN", e.message ?: "open chooser failed", e)
    }
  }
}
