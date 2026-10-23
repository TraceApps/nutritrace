package com.nutritrace.app

import android.database.sqlite.SQLiteDatabase
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.lifecycle.Observer
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant

/**
 * Health Connect's background-read permission (#294). Without it, Health
 * Connect answers reads only while NutriTrace is in front, so the hourly
 * worker (HealthConnectSyncWorker) can't read with the app closed.
 * developer.android.com, Health Connect, "Read data": declare
 * READ_HEALTH_DATA_IN_BACKGROUND, check FEATURE_READ_HEALTH_DATA_IN_BACKGROUND,
 * and ask for it like any other Health Connect permission.
 *
 * The Capacitor Health Connect plugin can only ask for record types, so this
 * asks for this one permission with Health Connect's own request screen.
 *
 * status()  -> { available, granted }
 * request() -> the same, after the user answered (only when available and
 *              not granted yet; otherwise it answers straight away).
 * runNow({ minAgeMs }) -> { started, reason? }: runs HealthConnectSyncWorker
 *              once now, while the app is in front, so the worker's reads
 *              (workouts, floors, water: the Capacitor plugin can't read
 *              them) happen without background access too. One at a time
 *              (a unique work name), and not when the worker is running or
 *              read less than minAgeMs ago. "workerDone" { changed } is sent
 *              when it finishes.
 */
@CapacitorPlugin(name = "HealthBackground")
class HealthBackgroundPlugin : Plugin() {
    companion object {
        const val PERMISSION = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
        const val NOW_WORK = "nutritrace_hc_sync_now"
        private const val DB_FILENAME = "nutritrace_localSQLite.db"

        /** Whether this phone's Health Connect can grant background reads. */
        fun available(client: HealthConnectClient): Boolean = try {
            client.features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
                HealthConnectFeatures.FEATURE_STATUS_AVAILABLE
        } catch (_: Exception) {
            false
        }
    }

    private val scope = CoroutineScope(Dispatchers.Main)
    private val contract = PermissionController.createRequestPermissionResultContract()

    private fun client(): HealthConnectClient? =
        if (HealthConnectClient.getSdkStatus(context) == HealthConnectClient.SDK_AVAILABLE) HealthConnectClient.getOrCreate(context) else null

    private fun answer(call: PluginCall, available: Boolean, granted: Boolean) {
        call.resolve(JSObject().apply {
            put("available", available)
            put("granted", granted)
        })
    }

    private fun resolveStatus(call: PluginCall) {
        val client = client() ?: return answer(call, false, false)
        if (!available(client)) return answer(call, false, false)
        scope.launch {
            val granted = try {
                client.permissionController.getGrantedPermissions().contains(PERMISSION)
            } catch (_: Exception) { false }
            answer(call, true, granted)
        }
    }

    @PluginMethod
    fun status(call: PluginCall) = resolveStatus(call)

    @PluginMethod
    fun request(call: PluginCall) {
        val client = client() ?: return answer(call, false, false)
        if (!available(client)) return answer(call, false, false)
        scope.launch {
            val granted = try {
                client.permissionController.getGrantedPermissions().contains(PERMISSION)
            } catch (_: Exception) { false }
            if (granted) return@launch answer(call, true, true)
            try {
                startActivityForResult(call, contract.createIntent(context, setOf(PERMISSION)), "onRequestResult")
            } catch (e: Exception) {
                call.reject("Could not open Health Connect: ${e.message}")
            }
        }
    }

    @ActivityCallback
    private fun onRequestResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        // The screen's answer can lag what Health Connect stores, so ask it.
        resolveStatus(call)
    }

    @PluginMethod
    fun runNow(call: PluginCall) {
        // Read as a JSON number: PluginCall.getDouble drops whole numbers.
        val minAgeMs = call.data.optLong("minAgeMs", 60_000L)
        val wm = WorkManager.getInstance(context)
        scope.launch {
            val reason = withContext(Dispatchers.IO) {
                val busy = try {
                    wm.getWorkInfosForUniqueWork(WorkerScheduler.HC_SYNC_WORK).get().any { it.state == WorkInfo.State.RUNNING } ||
                        wm.getWorkInfosForUniqueWork(NOW_WORK).get().any { !it.state.isFinished }
                } catch (_: Exception) { false }
                when {
                    busy -> "running"
                    ranWithin(minAgeMs) -> "recent"
                    else -> null
                }
            }
            if (reason != null) {
                call.resolve(JSObject().apply { put("started", false); put("reason", reason) })
                return@launch
            }
            val builder = OneTimeWorkRequestBuilder<HealthConnectSyncWorker>()
            // Expedited on Android 12 and up, where it needs no notification;
            // out of quota it runs as ordinary work.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            }
            val request = builder.build()
            wm.enqueueUniqueWork(NOW_WORK, ExistingWorkPolicy.KEEP, request)
            call.resolve(JSObject().apply { put("started", true) })
            val live = wm.getWorkInfoByIdLiveData(request.id)
            live.observeForever(object : Observer<WorkInfo?> {
                override fun onChanged(value: WorkInfo?) {
                    if (value == null || !value.state.isFinished) return
                    live.removeObserver(this)
                    notifyListeners("workerDone", JSObject().apply {
                        put("changed", value.outputData.getInt(HealthConnectSyncWorker.OUTPUT_CHANGED, 0))
                    })
                }
            })
        }
    }

    /** Whether the worker last read Health Connect less than ms ago (sync_meta 'hc_last_bg_sync_at'). */
    private fun ranWithin(ms: Long): Boolean {
        if (ms <= 0L) return false
        val dbFile = context.getDatabasePath(DB_FILENAME)
        if (!dbFile.exists()) return false
        var db: SQLiteDatabase? = null
        return try {
            db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            val last = db.rawQuery("SELECT value FROM sync_meta WHERE key = 'hc_last_bg_sync_at' LIMIT 1", null)
                .use { if (it.moveToFirst()) it.getString(0) else null } ?: return false
            val age = Instant.now().toEpochMilli() - Instant.parse(last).toEpochMilli()
            age in 0 until ms
        } catch (_: Exception) {
            false
        } finally {
            db?.close()
        }
    }
}
