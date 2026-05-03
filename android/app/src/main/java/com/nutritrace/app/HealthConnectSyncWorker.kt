package com.nutritrace.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/**
 * HealthConnectSyncWorker — native background HC reader.
 *
 * Reads today's data from Health Connect using the SDK directly (no JS plugin
 * needed) and writes results into the JS app's SQLite database under the
 * 'health_connect' source. Runs even when the app is closed.
 *
 * Battery-conscious:
 *  - Only enqueued when healthConnectEnabled = true (gated by WorkerScheduler)
 *  - 1-hour interval, NOT_REQUIRED network, batteryNotLow constraint
 *  - Each invocation: ~50ms HC reads + ~20ms SQLite writes
 *  - Read permissions checked first; bails if none granted
 */
class HealthConnectSyncWorker(
    context: Context,
    params: WorkerParameters
) : CoroutineWorker(context, params) {

    companion object {
        private const val TAG = "HCSyncWorker"
        private const val DB_FILENAME = "nutritrace_localSQLite.db"
        private const val SOURCE = "health_connect"
        private const val LOCAL_USER_ID = 1
    }

    override suspend fun doWork(): Result {
        return try {
            val ctx = applicationContext

            // Check HC availability
            val sdkStatus = HealthConnectClient.getSdkStatus(ctx)
            if (sdkStatus != HealthConnectClient.SDK_AVAILABLE) {
                Log.d(TAG, "HC not available: $sdkStatus")
                return Result.success()
            }

            val client = HealthConnectClient.getOrCreate(ctx)

            // Bail if no permissions (no notification spam, no errors)
            val granted = client.permissionController.getGrantedPermissions()
            if (granted.isEmpty()) {
                Log.d(TAG, "no HC permissions granted, skipping")
                return Result.success()
            }

            val zone = ZoneId.systemDefault()
            val today = LocalDate.now(zone)
            val todayStart = today.atStartOfDay(zone).toInstant()
            val now = Instant.now()
            val todayStr = today.toString() // yyyy-MM-dd

            val metrics = mutableMapOf<String, Number>()

            readMetrics(client, todayStart, now, metrics, granted)

            if (metrics.isEmpty()) {
                Log.d(TAG, "no metrics to write")
                return Result.success()
            }

            writeToDb(ctx, todayStr, metrics)
            Log.d(TAG, "synced ${metrics.size} metrics for $todayStr")
            Result.success()
        } catch (e: Exception) {
            Log.w(TAG, "worker failed: ${e.message}")
            Result.success() // never retry-spam
        }
    }

    private suspend fun readMetrics(
        client: HealthConnectClient,
        start: Instant,
        end: Instant,
        out: MutableMap<String, Number>,
        granted: Set<String>
    ) {
        val tr = TimeRangeFilter.between(start, end)

        // Steps (aggregate)
        if (granted.contains(HealthPermission.getReadPermission(StepsRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(StepsRecord.COUNT_TOTAL), tr))
                r[StepsRecord.COUNT_TOTAL]?.let { out["steps"] = it }
            }
        }

        // Distance (km)
        if (granted.contains(HealthPermission.getReadPermission(DistanceRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(DistanceRecord.DISTANCE_TOTAL), tr))
                r[DistanceRecord.DISTANCE_TOTAL]?.let {
                    out["distance_km"] = (it.inMeters / 1000.0 * 100).toLong() / 100.0
                }
            }
        }

        // Total calories
        if (granted.contains(HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(TotalCaloriesBurnedRecord.ENERGY_TOTAL), tr))
                r[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.let { out["calories_out"] = it.inKilocalories.toInt() }
            }
        }

        // Active calories
        if (granted.contains(HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL), tr))
                r[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.let { out["active_calories"] = it.inKilocalories.toInt() }
            }
        }

        // Avg HR
        if (granted.contains(HealthPermission.getReadPermission(HeartRateRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(HeartRateRecord.BPM_AVG), tr))
                r[HeartRateRecord.BPM_AVG]?.let { out["avg_heart_rate"] = it.toInt() }
            }
        }

        // Resting HR (latest record)
        if (granted.contains(HealthPermission.getReadPermission(RestingHeartRateRecord::class))) {
            tryRead {
                val records = client.readRecords(ReadRecordsRequest(RestingHeartRateRecord::class, tr)).records
                records.lastOrNull()?.let { out["resting_hr"] = it.beatsPerMinute.toInt() }
            }
        }

        // Weight (latest)
        if (granted.contains(HealthPermission.getReadPermission(WeightRecord::class))) {
            tryRead {
                val records = client.readRecords(ReadRecordsRequest(WeightRecord::class, tr)).records
                records.lastOrNull()?.let {
                    val kg = it.weight.inKilograms
                    if (kg > 0) out["weight_kg"] = (kg * 10).toLong() / 10.0
                }
            }
        }

        // Sleep session — look back 24h for last night's sleep
        if (granted.contains(HealthPermission.getReadPermission(SleepSessionRecord::class))) {
            tryRead {
                val sleepStart = end.minus(24, ChronoUnit.HOURS)
                val records = client.readRecords(
                    ReadRecordsRequest(SleepSessionRecord::class, TimeRangeFilter.between(sleepStart, end))
                ).records
                records.lastOrNull()?.let { sleep ->
                    val durMs = sleep.endTime.toEpochMilli() - sleep.startTime.toEpochMilli()
                    out["sleep_duration_min"] = (durMs / 60000).toInt()
                    var deep = 0L; var rem = 0L; var light = 0L; var awake = 0L
                    for (stage in sleep.stages) {
                        val durMin = (stage.endTime.toEpochMilli() - stage.startTime.toEpochMilli()) / 60000
                        when (stage.stage) {
                            SleepSessionRecord.STAGE_TYPE_DEEP -> deep += durMin
                            SleepSessionRecord.STAGE_TYPE_REM -> rem += durMin
                            SleepSessionRecord.STAGE_TYPE_LIGHT -> light += durMin
                            SleepSessionRecord.STAGE_TYPE_AWAKE,
                            SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED -> awake += durMin
                        }
                    }
                    if (deep > 0) out["sleep_deep_min"] = deep.toInt()
                    if (rem > 0) out["sleep_rem_min"] = rem.toInt()
                    if (light > 0) out["sleep_light_min"] = light.toInt()
                    if (awake > 0) out["sleep_awake_min"] = awake.toInt()
                }
            }
        }

        // Body fat (latest)
        if (granted.contains(HealthPermission.getReadPermission(BodyFatRecord::class))) {
            tryRead {
                val records = client.readRecords(ReadRecordsRequest(BodyFatRecord::class, tr)).records
                records.lastOrNull()?.let {
                    val pct = it.percentage.value
                    if (pct > 0) out["body_fat_pct"] = (pct * 10).toLong() / 10.0
                }
            }
        }

        // SpO2 (latest)
        if (granted.contains(HealthPermission.getReadPermission(OxygenSaturationRecord::class))) {
            tryRead {
                val records = client.readRecords(ReadRecordsRequest(OxygenSaturationRecord::class, tr)).records
                records.lastOrNull()?.let { out["spo2_avg"] = it.percentage.value }
            }
        }

        // Respiratory rate (latest)
        if (granted.contains(HealthPermission.getReadPermission(RespiratoryRateRecord::class))) {
            tryRead {
                val records = client.readRecords(ReadRecordsRequest(RespiratoryRateRecord::class, tr)).records
                records.lastOrNull()?.let { out["respiratory_rate"] = (it.rate * 10).toLong() / 10.0 }
            }
        }

        // Floors
        if (granted.contains(HealthPermission.getReadPermission(FloorsClimbedRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL), tr))
                r[FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL]?.let { out["floors"] = it.toInt() }
            }
        }

        // Hydration (liters → ml)
        if (granted.contains(HealthPermission.getReadPermission(HydrationRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(HydrationRecord.VOLUME_TOTAL), tr))
                r[HydrationRecord.VOLUME_TOTAL]?.let { out["water_ml"] = (it.inLiters * 1000).toInt() }
            }
        }
    }

    private inline fun tryRead(block: () -> Unit) {
        try { block() } catch (e: Exception) { Log.d(TAG, "read skipped: ${e.message}") }
    }

    private fun writeToDb(ctx: Context, dateStr: String, metrics: Map<String, Number>) {
        val dbFile = ctx.getDatabasePath(DB_FILENAME)
        if (!dbFile.exists()) {
            Log.d(TAG, "DB not found at ${dbFile.absolutePath}")
            return
        }
        var db: SQLiteDatabase? = null
        try {
            db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            db.beginTransaction()
            try {
                for ((type, value) in metrics) {
                    val cv = ContentValues().apply {
                        put("user_id", LOCAL_USER_ID)
                        put("date", dateStr)
                        put("source", SOURCE)
                        put("metric_type", type)
                        put("value", value.toDouble())
                        put("metadata", "{}")
                    }
                    // Match the JS upsert: ON CONFLICT(user_id, date, source, metric_type) DO UPDATE
                    db.execSQL(
                        """INSERT INTO wellness_data (user_id, date, source, metric_type, value, metadata)
                           VALUES (?, ?, ?, ?, ?, ?)
                           ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
                             value=excluded.value, metadata=excluded.metadata, synced_at=datetime('now')""",
                        arrayOf(LOCAL_USER_ID, dateStr, SOURCE, type, value.toDouble(), "{}")
                    )
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        } catch (e: Exception) {
            Log.w(TAG, "DB write failed: ${e.message}")
        } finally {
            db?.close()
        }
    }
}
