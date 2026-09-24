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
import androidx.health.connect.client.records.ExerciseSessionRecord
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
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
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
            // Cumulative aggregate window ends at next midnight so day-spanning
            // source records (Samsung Health writes one 00:00-23:59 Steps
            // record per day and updates in place) are fully contained.
            // Health Connect's aggregate math prorates a partial-overlap
            // window by overlap/duration, so ending at `now` gives
            // 9878 * elapsed_fraction at 11:47 instead of the full 9878.
            // Granular writers (Google Fit, Fitbit-to-HC, phone sensors) are
            // unaffected because no records exist past `now`. #93.
            val tomorrowStart = today.plusDays(1).atStartOfDay(zone).toInstant()
            val now = Instant.now()
            val todayStr = today.toString() // yyyy-MM-dd

            val metrics = mutableMapOf<String, Number>()

            readMetrics(client, todayStart, now, tomorrowStart, metrics, granted)

            // Exercise sessions → workouts. Reads if the ExerciseSession
            // permission was granted; each session gets per-session calories
            // by reading TotalCaloriesBurned records over the session window
            // and filtering out any record whose span is >4x the session or
            // >6h (day-blob records — Samsung Health). Aggregating over the
            // window would time-prorate those day-blobs and inflate the burn.
            // If no granular records remain, calories = null and server falls
            // back to its METs estimate. #91 + #93 (traebertthomas-cpu).
            val workouts = mutableListOf<WorkoutRow>()
            if (granted.contains(HealthPermission.getReadPermission(ExerciseSessionRecord::class))) {
                tryRead {
                    val sessions = client.readRecords(
                        ReadRecordsRequest(ExerciseSessionRecord::class, TimeRangeFilter.between(todayStart, now))
                    ).records
                    for (s in sessions) {
                        val cal = try {
                            val sessionMs = ChronoUnit.MILLIS.between(s.startTime, s.endTime).coerceAtLeast(1L)
                            val maxRecordMs = minOf(sessionMs * 4L, 6L * 60L * 60L * 1000L)
                            val calRecords = client.readRecords(
                                ReadRecordsRequest(
                                    TotalCaloriesBurnedRecord::class,
                                    TimeRangeFilter.between(s.startTime, s.endTime)
                                )
                            ).records
                            val sumKcal = calRecords
                                .filter {
                                    val dur = ChronoUnit.MILLIS.between(it.startTime, it.endTime)
                                    dur in 1L..maxRecordMs
                                }
                                .sumOf { it.energy.inKilocalories }
                            if (sumKcal > 0.0) Math.round(sumKcal).toInt() else null
                        } catch (_: Exception) { null }

                        val zoneForDate = s.startZoneOffset ?: zone
                        val localDate = s.startTime.atZone(zoneForDate).toLocalDate().toString()
                        val durationMs = ChronoUnit.MILLIS.between(s.startTime, s.endTime).coerceAtLeast(0L)
                        val stableId = s.metadata.id.ifBlank { "${s.startTime}|${s.endTime}|${s.exerciseType}" }
                        val typeStr = s.exerciseType.toString()

                        workouts.add(
                            WorkoutRow(
                                sourceId = stableId,
                                date = localDate,
                                activityType = typeStr,
                                activityName = s.title ?: typeStr,
                                startTime = s.startTime.toString(),
                                durationMs = durationMs,
                                calories = cal
                            )
                        )
                    }
                }
            }

            if (metrics.isEmpty() && workouts.isEmpty()) {
                Log.d(TAG, "no metrics or workouts to write")
                return Result.success()
            }

            writeToDb(ctx, todayStr, metrics, workouts)

            // Push to server so users on browser / other devices see today's
            // fresh metrics without needing to open the Android app first
            // (the original bug behind #68). Best-effort: failures here don't
            // surface to the user; the local SQLite write above already
            // succeeded, and the JS-side sync will catch up on next app open.
            val (serverUrl, authToken) = readServerCredentials(ctx)
            if (!serverUrl.isNullOrBlank() && !authToken.isNullOrBlank()) {
                pushToServer(serverUrl, authToken, todayStr, metrics, workouts)
            } else {
                Log.d(TAG, "no server credentials in sync_meta, skipping server push (local-mode install?)")
            }

            // Stamp the last-sync timestamp so the Settings UI can show
            // "Last synced X minutes ago" without polling the worker.
            writeSyncMeta(ctx, "hc_last_bg_sync_at", Instant.now().toString())

            Log.d(TAG, "synced ${metrics.size} metrics + ${workouts.size} workouts for $todayStr")
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
        aggregateEnd: Instant,
        out: MutableMap<String, Number>,
        granted: Set<String>
    ) {
        val tr = TimeRangeFilter.between(start, end)
        // Cumulative aggregates need aggregateEnd (next midnight) so
        // day-blob source records (Samsung Health) aren't time-prorated. #93.
        val cumTr = TimeRangeFilter.between(start, aggregateEnd)

        // Steps (aggregate)
        if (granted.contains(HealthPermission.getReadPermission(StepsRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(StepsRecord.COUNT_TOTAL), cumTr))
                r[StepsRecord.COUNT_TOTAL]?.let { out["steps"] = it }
            }
        }

        // Distance (km)
        if (granted.contains(HealthPermission.getReadPermission(DistanceRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(DistanceRecord.DISTANCE_TOTAL), cumTr))
                r[DistanceRecord.DISTANCE_TOTAL]?.let {
                    out["distance_km"] = (it.inMeters / 1000.0 * 100).toLong() / 100.0
                }
            }
        }

        // Total calories
        if (granted.contains(HealthPermission.getReadPermission(TotalCaloriesBurnedRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(TotalCaloriesBurnedRecord.ENERGY_TOTAL), cumTr))
                r[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.let { out["calories_out"] = it.inKilocalories.toInt() }
            }
        }

        // Active calories
        if (granted.contains(HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL), cumTr))
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

        // Sleep: every session of the night, not just the last one (#236).
        // SleepDerivation is a port of src/lib/sleep-sessions.js, the code the
        // foreground sync runs, and both are held to the same fixtures, so
        // this path and the foreground one store the same numbers. The window
        // opens at yesterday's midnight so a night that began yesterday
        // evening is read whole.
        if (granted.contains(HealthPermission.getReadPermission(SleepSessionRecord::class))) {
            tryRead {
                val zone = ZoneId.systemDefault()
                val day = start.atZone(zone).toLocalDate()
                val sleepFrom = day.minusDays(1).atStartOfDay(zone).toInstant()
                val records = client.readRecords(
                    ReadRecordsRequest(SleepSessionRecord::class, TimeRangeFilter.between(sleepFrom, end))
                ).records
                val sessions = records.map { r ->
                    SleepDerivation.RawSession(
                        id = r.metadata.id,
                        origin = r.metadata.dataOrigin.packageName,
                        start = r.startTime.toEpochMilli(),
                        end = r.endTime.toEpochMilli(),
                        stages = r.stages.map {
                            SleepDerivation.RawStage(it.stage, it.startTime.toEpochMilli(), it.endTime.toEpochMilli())
                        }
                    )
                }
                out.putAll(SleepDerivation.derive(sessions, day.toString(), zone))
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
                val r = client.aggregate(AggregateRequest(setOf(FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL), cumTr))
                r[FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL]?.let { out["floors"] = it.toInt() }
            }
        }

        // Hydration (liters → ml)
        if (granted.contains(HealthPermission.getReadPermission(HydrationRecord::class))) {
            tryRead {
                val r = client.aggregate(AggregateRequest(setOf(HydrationRecord.VOLUME_TOTAL), cumTr))
                r[HydrationRecord.VOLUME_TOTAL]?.let { out["water_ml"] = (it.inLiters * 1000).toInt() }
            }
        }
    }

    private inline fun tryRead(block: () -> Unit) {
        try { block() } catch (e: Exception) { Log.d(TAG, "read skipped: ${e.message}") }
    }

    /**
     * Read serverUrl + authToken from the sync_meta table that JS keeps
     * up to date via platform.js#_mirrorAuthToSyncMeta. Returns (null, null)
     * if either is missing (local-mode install or pre-mirror app version).
     */
    private fun readServerCredentials(ctx: Context): Pair<String?, String?> {
        val dbFile = ctx.getDatabasePath(DB_FILENAME)
        if (!dbFile.exists()) return Pair(null, null)
        var db: SQLiteDatabase? = null
        return try {
            db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY)
            val url = readSyncMeta(db, "server_url")
            val token = readSyncMeta(db, "auth_token")
            Pair(url, token)
        } catch (e: Exception) {
            Log.w(TAG, "credential read failed: ${e.message}")
            Pair(null, null)
        } finally {
            db?.close()
        }
    }

    private fun readSyncMeta(db: SQLiteDatabase, key: String): String? {
        val cursor = db.rawQuery("SELECT value FROM sync_meta WHERE key = ? LIMIT 1", arrayOf(key))
        return cursor.use { if (it.moveToFirst()) it.getString(0) else null }
    }

    /** Write a (key, value) row to sync_meta, upserting. Used for the
     *  last-background-sync timestamp the Settings UI surfaces. */
    private fun writeSyncMeta(ctx: Context, key: String, value: String) {
        val dbFile = ctx.getDatabasePath(DB_FILENAME)
        if (!dbFile.exists()) return
        var db: SQLiteDatabase? = null
        try {
            db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            db.execSQL(
                "INSERT INTO sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                arrayOf(key, value)
            )
        } catch (e: Exception) {
            Log.w(TAG, "sync_meta write failed: ${e.message}")
        } finally {
            db?.close()
        }
    }

    /**
     * POST the freshly-synced metrics to the server's /api/sync/push endpoint.
     * Payload matches what the JS sync engine sends:
     *   { "wellness": [{"date", "source", "metric_type", "value", "metadata"}, ...] }
     * Same authorization header pattern (Bearer + JWT) the JS app uses.
     */
    private fun pushToServer(
        serverUrl: String,
        authToken: String,
        dateStr: String,
        metrics: Map<String, Number>,
        workouts: List<WorkoutRow>
    ) {
        var conn: HttpURLConnection? = null
        try {
            val wellnessArr = JSONArray()
            for ((type, value) in metrics) {
                wellnessArr.put(JSONObject().apply {
                    put("date", dateStr)
                    put("source", SOURCE)
                    put("metric_type", type)
                    put("value", value.toDouble())
                    put("metadata", JSONObject())
                })
            }
            val workoutsArr = JSONArray()
            for (w in workouts) {
                workoutsArr.put(JSONObject().apply {
                    put("source", SOURCE)
                    put("source_id", w.sourceId)
                    put("date", w.date)
                    put("activity_type", w.activityType)
                    put("activity_name", w.activityName)
                    put("start_time", w.startTime)
                    put("duration_ms", w.durationMs)
                    put("distance_km", JSONObject.NULL)
                    if (w.calories != null) put("calories", w.calories) else put("calories", JSONObject.NULL)
                    put("avg_hr", JSONObject.NULL)
                    put("max_hr", JSONObject.NULL)
                    put("steps", JSONObject.NULL)
                    put("has_gps", 0)
                })
            }
            val payload = JSONObject().apply {
                put("foods", JSONArray())
                put("meals", JSONArray())
                put("diary", JSONArray())
                put("activity", JSONArray())
                put("fasts", JSONArray())
                put("wellness", wellnessArr)
                put("settings", JSONArray())
                put("workouts", workoutsArr)
            }.toString()

            val url = URL("${serverUrl.trimEnd('/')}/api/sync/push")
            conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Authorization", "Bearer $authToken")
                doOutput = true
                connectTimeout = 10_000
                readTimeout = 15_000
            }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(payload) }

            val code = conn.responseCode
            if (code in 200..299) {
                Log.d(TAG, "server push ok: $code (${metrics.size} metrics + ${workouts.size} workouts)")
            } else {
                Log.w(TAG, "server push failed: HTTP $code")
            }
        } catch (e: Exception) {
            Log.w(TAG, "server push failed: ${e.message}")
        } finally {
            conn?.disconnect()
        }
    }

    /**
     * Local-write shape for an ExerciseSession-derived workout. Kotlin-side
     * mirror of the JS `readExerciseSessions()` return object. Written to the
     * local `workouts` table and pushed to /api/sync/push. Follows the
     * source='health_connect' convention shared with the JS path.
     */
    private data class WorkoutRow(
        val sourceId: String,
        val date: String,
        val activityType: String?,
        val activityName: String?,
        val startTime: String?,
        val durationMs: Long?,
        val calories: Int?
    )

    private fun writeToDb(ctx: Context, dateStr: String, metrics: Map<String, Number>, workouts: List<WorkoutRow>) {
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
                // Workouts — one row per HC ExerciseSession. Keyed by
                // (user_id, source, source_id); on conflict every field
                // gets refreshed from the incoming row so a later HC edit
                // (e.g. calorie refinement) propagates. server_id stays
                // NULL locally until the sync push confirms it — the JS
                // sync loop sets it via dbSetWorkoutServerId.
                for (w in workouts) {
                    db.execSQL(
                        """INSERT INTO workouts (user_id, source, source_id, date, activity_type, activity_name, start_time, duration_ms, calories, has_gps, updated_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
                           ON CONFLICT(user_id, source, source_id) DO UPDATE SET
                             date=excluded.date, activity_type=excluded.activity_type,
                             activity_name=excluded.activity_name, start_time=excluded.start_time,
                             duration_ms=excluded.duration_ms, calories=excluded.calories,
                             updated_at=datetime('now')""",
                        arrayOf(
                            LOCAL_USER_ID, SOURCE, w.sourceId, w.date,
                            w.activityType, w.activityName, w.startTime,
                            w.durationMs, w.calories
                        )
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
