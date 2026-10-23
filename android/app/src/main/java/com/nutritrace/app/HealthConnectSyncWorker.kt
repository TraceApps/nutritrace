package com.nutritrace.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.util.Log
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.FloorsClimbedRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
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
import androidx.work.workDataOf
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
import kotlin.reflect.KClass

/**
 * HealthConnectSyncWorker: native background HC reader.
 *
 * Reads Health Connect with the SDK directly (no JS plugin needed) and
 * writes results into the JS app's SQLite database under the
 * 'health_connect' source, each day's values under that day (#294). Runs
 * even when the app is closed.
 *
 * Each run reads today. When a catch-up is due (HealthConnectDays: at most
 * hourly, shared with the foreground sync through sync_meta) it also reads
 * the last 7 days, 30 on the first run, so a past day another app filled in
 * or edited later reaches NutriTrace. Only values that changed are written
 * as pending and sent to the server; a run with nothing new sends nothing.
 *
 * Battery-conscious:
 *  - Only enqueued when healthConnectEnabled = true (gated by WorkerScheduler)
 *  - 1-hour interval, NOT_REQUIRED network, batteryNotLow constraint
 *  - Totals: one aggregate call per day for every granted type together;
 *    readings, sleep and workouts: one read per type for all the days
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
        const val OUTPUT_CHANGED = "changed"
    }

    /** One wellness value for one day. */
    private data class WellnessRow(val date: String, val type: String, val value: Double)

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

            // Without the background-read permission Health Connect refuses
            // reads while the app isn't in front; the run then reads nothing
            // and the app reads when it opens (#294).
            if (!granted.contains(HealthBackgroundPlugin.PERMISSION)) {
                Log.d(TAG, "background reads not allowed: Health Connect answers only while NutriTrace is open")
            }

            val zone = ZoneId.systemDefault()
            val today = LocalDate.now(zone)
            val now = Instant.now()
            val todayStr = today.toString() // yyyy-MM-dd

            val catchUp = HealthConnectDays.catchUpDue(readMetaValue(ctx, HealthConnectDays.META_AT), now)
            val from = if (catchUp) HealthConnectDays.catchUpFrom(today, readMetaValue(ctx, HealthConnectDays.META_DAY)) else today
            val days = generateSequence(from) { it.plusDays(1) }.takeWhile { !it.isAfter(today) }.toList()

            val reader = DayReader(client, granted, zone, now, today)
            val byDay = reader.readDays(days)
            val workouts = reader.readWorkouts(days)

            val rows = byDay.flatMap { (date, metrics) ->
                metrics.map { (type, value) -> WellnessRow(date, type, value.toDouble()) }
            }
            val written = writeToDb(ctx, rows, workouts)
            val changedRows = written?.first ?: emptyList()
            val changedWorkouts = written?.second ?: emptyList()

            // A catch-up counts only when every read and the write worked. Without the
            // background-read permission, Health Connect refuses reads while
            // the app isn't in front; stamping then would hold the app's own
            // catch-up back for an hour.
            if (catchUp && reader.failed == 0 && reader.succeeded > 0 && written != null) {
                writeSyncMeta(ctx, HealthConnectDays.META_AT, now.toString())
                writeSyncMeta(ctx, HealthConnectDays.META_DAY, todayStr)
            }
            if (reader.succeeded > 0) {
                // Stamp the last-sync timestamp so the Settings UI can show
                // "Last synced X minutes ago" without polling the worker.
                writeSyncMeta(ctx, "hc_last_bg_sync_at", Instant.now().toString())
            }

            Log.d(TAG, "read ${days.size} day(s) from $from: ${rows.size} values (${changedRows.size} changed), ${workouts.size} workouts (${changedWorkouts.size} changed), ${reader.failed} failed reads")

            // How many values and workouts changed, for the app to refresh on
            // (HealthBackgroundPlugin.runNow).
            val out = workDataOf(OUTPUT_CHANGED to changedRows.size + changedWorkouts.size)
            if (changedRows.isEmpty() && changedWorkouts.isEmpty()) {
                Log.d(TAG, "nothing changed, nothing to send")
                return Result.success(out)
            }

            // Push to server so users on browser / other devices see the
            // fresh metrics without needing to open the Android app first
            // (the original bug behind #68). Best-effort: the rows stay
            // pending until the push works, and the JS-side sync sends them
            // on the next app open otherwise.
            val (serverUrl, authToken, httpOk) = readServerCredentials(ctx)
            // Plain http:// only to a server on your own network that the
            // app confirmed (#194, LocalAddress.kt); nothing is sent otherwise.
            val base = LocalAddress.workerBase(serverUrl, httpOk)
            if (!serverUrl.isNullOrBlank() && !authToken.isNullOrBlank() && base == null) {
                Log.d(TAG, "server address not usable here (not https, or plain HTTP not confirmed for a server on your own network), skipping server push")
            } else if (!serverUrl.isNullOrBlank() && !authToken.isNullOrBlank() && !dataIsTokensAccount(ctx, serverUrl, base!!, authToken)) {
                // The local database still holds another account's data (a
                // sign-in the app hasn't finished checking, see
                // src/lib/local-account.js). Nothing goes up under this
                // token; the app sends the values once it has checked.
                Log.d(TAG, "local data belongs to another account, skipping server push")
            } else if (!serverUrl.isNullOrBlank() && !authToken.isNullOrBlank()) {
                val answer = pushToServer(base!!, authToken, changedRows, changedWorkouts)
                if (answer != null) {
                    markSynced(ctx, changedRows)
                    setWorkoutServerIds(ctx, answer, changedWorkouts)
                }
            } else {
                Log.d(TAG, "no server credentials in sync_meta, skipping server push (local-mode install?)")
            }

            Result.success(out)
        } catch (e: Exception) {
            Log.w(TAG, "worker failed: ${e.message}")
            Result.success() // never retry-spam
        }
    }

    /**
     * Reads Health Connect for a list of consecutive days, each day's values
     * under that day: totals over its own midnight to midnight, the latest
     * reading taken that day, the night you woke up from that day. The same
     * rules as readDays in src/lib/health-connect.js. `failed` counts reads
     * that threw, `succeeded` the ones that worked.
     */
    private class DayReader(
        val client: HealthConnectClient,
        val granted: Set<String>,
        val zone: ZoneId,
        val now: Instant,
        val today: LocalDate
    ) {
        var failed = 0
        var succeeded = 0

        fun has(type: KClass<out Record>) = granted.contains(HealthPermission.getReadPermission(type))

        private inline fun attempt(what: String, block: () -> Unit) {
            try { block(); succeeded++ } catch (e: Exception) { failed++; Log.d(TAG, "$what read skipped: ${e.message}") }
        }

        fun dayStart(d: LocalDate): Instant = d.atStartOfDay(zone).toInstant()

        /** Every record of a type in a time range, page by page (1000 a page). */
        suspend fun <T : Record> readAll(type: KClass<T>, range: TimeRangeFilter): List<T> {
            val out = mutableListOf<T>()
            var token: String? = null
            do {
                val page = client.readRecords(ReadRecordsRequest(type, range, pageToken = token))
                out += page.records
                token = page.pageToken
            } while (!token.isNullOrEmpty())
            return out
        }

        suspend fun readDays(days: List<LocalDate>): Map<String, MutableMap<String, Number>> {
            val out = linkedMapOf<String, MutableMap<String, Number>>()
            for (d in days) out[d.toString()] = mutableMapOf()
            if (days.isEmpty()) return out
            val start = dayStart(days.first())

            // Totals: every granted type in one call per day. The window
            // ends at the next midnight, not now, so a day-spanning record
            // (Samsung Health writes one 00:00-23:59 Steps record per day and
            // updates it in place) is fully contained; Health Connect
            // prorates a partial overlap by overlap/duration. #93.
            val metrics = buildSet<AggregateMetric<*>> {
                if (has(StepsRecord::class)) add(StepsRecord.COUNT_TOTAL)
                if (has(DistanceRecord::class)) add(DistanceRecord.DISTANCE_TOTAL)
                if (has(TotalCaloriesBurnedRecord::class)) add(TotalCaloriesBurnedRecord.ENERGY_TOTAL)
                if (has(ActiveCaloriesBurnedRecord::class)) add(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)
                if (has(HeartRateRecord::class)) add(HeartRateRecord.BPM_AVG)
                if (has(FloorsClimbedRecord::class)) add(FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL)
                if (has(HydrationRecord::class)) add(HydrationRecord.VOLUME_TOTAL)
            }
            if (metrics.isNotEmpty()) {
                for (d in days) {
                    val m = out.getValue(d.toString())
                    // The app keeps a total of 0 for today only; on other
                    // days 0 means nothing was recorded (src/lib/health-connect.js).
                    fun put(key: String, v: Number) { if (d == today || v.toDouble() != 0.0) m[key] = v }
                    attempt("aggregate $d") {
                        val r = client.aggregate(AggregateRequest(metrics, TimeRangeFilter.between(dayStart(d), dayStart(d.plusDays(1)))))
                        r[StepsRecord.COUNT_TOTAL]?.let { put("steps", it) }
                        r[DistanceRecord.DISTANCE_TOTAL]?.let { put("distance_km", HealthConnectDays.round(it.inMeters / 1000.0, 2)) }
                        r[TotalCaloriesBurnedRecord.ENERGY_TOTAL]?.let { put("calories_out", Math.round(it.inKilocalories).toInt()) }
                        r[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.let { put("active_calories", Math.round(it.inKilocalories).toInt()) }
                        r[HeartRateRecord.BPM_AVG]?.let { put("avg_heart_rate", it.toInt()) }
                        r[FloorsClimbedRecord.FLOORS_CLIMBED_TOTAL]?.let { put("floors", Math.round(it).toInt()) }
                        r[HydrationRecord.VOLUME_TOTAL]?.let { put("water_ml", Math.round(it.inLiters * 1000).toInt()) }
                    }
                }
            }

            // Readings: the latest one of each day, one read per type.
            val tr = TimeRangeFilter.between(start, now)
            fun <T : Record> latest(records: List<T>, time: (T) -> Instant, write: (MutableMap<String, Number>, T) -> Unit) {
                records.groupBy { time(it).atZone(zone).toLocalDate().toString() }.forEach { (day, list) ->
                    val m = out[day] ?: return@forEach
                    // The latest; of two at the same time, the one read last,
                    // as the foreground sync picks it.
                    write(m, list.sortedBy { time(it) }.last())
                }
            }
            if (has(RestingHeartRateRecord::class)) attempt("RestingHeartRate") {
                latest(readAll(RestingHeartRateRecord::class, tr), { it.time }) { m, r ->
                    m["resting_hr"] = r.beatsPerMinute.toInt()
                }
            }
            if (has(WeightRecord::class)) attempt("Weight") {
                latest(readAll(WeightRecord::class, tr), { it.time }) { m, r ->
                    val kg = r.weight.inKilograms
                    if (kg > 0) m["weight_kg"] = HealthConnectDays.round(kg, 1)
                }
            }
            if (has(BodyFatRecord::class)) attempt("BodyFat") {
                latest(readAll(BodyFatRecord::class, tr), { it.time }) { m, r ->
                    val pct = r.percentage.value
                    if (pct > 0) m["body_fat_pct"] = HealthConnectDays.round(pct, 1)
                }
            }
            if (has(OxygenSaturationRecord::class)) attempt("OxygenSaturation") {
                latest(readAll(OxygenSaturationRecord::class, tr), { it.time }) { m, r ->
                    val pct = r.percentage.value
                    if (pct > 0) m["spo2_avg"] = HealthConnectDays.round(pct, 1)
                }
            }
            if (has(RespiratoryRateRecord::class)) attempt("RespiratoryRate") {
                latest(readAll(RespiratoryRateRecord::class, tr), { it.time }) { m, r ->
                    if (r.rate > 0) m["respiratory_rate"] = HealthConnectDays.round(r.rate, 1)
                }
            }

            // Sleep: every session of each night, not just the last one
            // (#236). SleepDerivation is a port of src/lib/sleep-sessions.js,
            // the code the foreground sync runs, and both are held to the
            // same fixtures, so this path and the foreground one store the
            // same numbers. The read opens at midnight the day before the
            // first day, so a night that began that evening is read whole.
            if (has(SleepSessionRecord::class)) attempt("SleepSession") {
                val sleepFrom = dayStart(days.first().minusDays(1))
                val records = readAll(SleepSessionRecord::class, TimeRangeFilter.between(sleepFrom, now))
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
                for (d in days) out.getValue(d.toString()).putAll(SleepDerivation.derive(sessions, d.toString(), zone))
            }
            return out
        }

        /**
         * Exercise sessions that started on one of `days` -> workouts. Each
         * session gets per-session calories by reading TotalCaloriesBurned
         * records over the session window and filtering out any record whose
         * span is >4x the session or >6h (day-blob records, Samsung Health).
         * Aggregating over the window would time-prorate those day-blobs and
         * inflate the burn. If no granular records remain, calories = null
         * and the server falls back to its METs estimate. #91 + #93
         * (traebertthomas-cpu).
         */
        suspend fun readWorkouts(days: List<LocalDate>): List<WorkoutRow> {
            val workouts = mutableListOf<WorkoutRow>()
            if (days.isEmpty() || !has(ExerciseSessionRecord::class)) return workouts
            val wanted = days.map { it.toString() }.toSet()
            attempt("ExerciseSession") {
                val sessions = readAll(ExerciseSessionRecord::class, TimeRangeFilter.between(dayStart(days.first()), now))
                for (s in sessions) {
                    val zoneForDate = s.startZoneOffset ?: zone
                    val localDate = s.startTime.atZone(zoneForDate).toLocalDate().toString()
                    if (localDate !in wanted) continue
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
            return workouts
        }
    }

    /** A sync_meta value, or null. */
    private fun readMetaValue(ctx: Context, key: String): String? {
        val dbFile = ctx.getDatabasePath(DB_FILENAME)
        if (!dbFile.exists()) return null
        var db: SQLiteDatabase? = null
        return try {
            db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            readSyncMeta(db, key)
        } catch (e: Exception) {
            null
        } finally {
            db?.close()
        }
    }

    /**
     * Read serverUrl + authToken from the sync_meta table that JS keeps
     * up to date via platform.js#_mirrorAuthToSyncMeta. Returns nulls
     * if either is missing (local-mode install or pre-mirror app version).
     * The third value, 'server_http_ok', is the server URL again when the
     * app confirmed plain HTTP to it (#194), and empty or missing otherwise.
     */
    private fun readServerCredentials(ctx: Context): Triple<String?, String?, String?> {
        val dbFile = ctx.getDatabasePath(DB_FILENAME)
        if (!dbFile.exists()) return Triple(null, null, null)
        var db: SQLiteDatabase? = null
        return try {
            db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            val url = readSyncMeta(db, "server_url")
            val token = readSyncMeta(db, "auth_token")
            val httpOk = readSyncMeta(db, "server_http_ok")
            Triple(url, token, httpOk)
        } catch (e: Exception) {
            Log.w(TAG, "credential read failed: ${e.message}")
            Triple(null, null, null)
        } finally {
            db?.close()
        }
    }

    /**
     * Whether the local database is the token's account's on this server,
     * by the tag the app keeps in sync_meta 'account'
     * (src/lib/local-account.js): JSON with the user id "u", the server's
     * address "s" and its instance id "i". Another user id is another
     * account; the same user id at the same address is the same. At
     * another address only two known, equal instance ids make it the same
     * server; anything less is for the person to decide in the app, so
     * the worker doesn't send. No tag, a local-mode tag, or a token
     * without an id in it doesn't block. `base` is where to ask
     * (LocalAddress.workerBase): the saved address for https://.
     */
    private fun dataIsTokensAccount(ctx: Context, serverUrl: String, base: String, token: String): Boolean {
        val owner = try {
            val dbFile = ctx.getDatabasePath(DB_FILENAME)
            if (!dbFile.exists()) return true
            val db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            try { readSyncMeta(db, "account") } finally { db.close() }
        } catch (e: Exception) {
            Log.w(TAG, "account tag read failed: ${e.message}")
            return false
        }
        if (owner.isNullOrBlank()) return true
        val tag = try { JSONObject(owner) } catch (e: Exception) { return false }
        if (tag.optBoolean("local", false) || tag.isNull("u")) return true
        val ownerId = tag.get("u").toString()
        val tokenId = try {
            val part = token.split(".").getOrNull(1) ?: return true
            val json = String(android.util.Base64.decode(part, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP), Charsets.UTF_8)
            val payload = JSONObject(json)
            if (payload.isNull("id")) return true
            payload.get("id").toString()
        } catch (e: Exception) {
            return true
        }
        if (ownerId != tokenId) return false
        val here = serverUrl.trim().trimEnd('/').lowercase()
        val ownerServer = tag.optString("s", "")
        if (ownerServer.isEmpty() || ownerServer == here) return true
        val ownerInstance = tag.optString("i", "")
        if (ownerInstance.isEmpty()) return false
        val instance = fetchInstanceId(if (base == serverUrl) here else base) ?: return false
        return instance == ownerInstance
    }

    /** The server's instance id from /api/auth/status, or null. */
    private fun fetchInstanceId(serverUrl: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            val url = URL("$serverUrl/api/auth/status")
            conn = (url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 10_000
                // Plain HTTP stays with the checked server (#194).
                if (url.protocol == "http") instanceFollowRedirects = false
            }
            if (conn.responseCode !in 200..299) return null
            val body = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            JSONObject(body).optString("instance_id", "").ifEmpty { null }
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
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
     * POST the changed values to the server's /api/sync/push endpoint.
     * Payload matches what the JS sync engine sends:
     *   { "wellness": [{"date", "source", "metric_type", "value", "metadata"}, ...] }
     * Same authorization header pattern (Bearer + JWT) the JS app uses.
     * The server's answer when it took them, null otherwise.
     */
    private fun pushToServer(
        serverUrl: String,
        authToken: String,
        rows: List<WellnessRow>,
        workouts: List<WorkoutRow>
    ): JSONObject? {
        var conn: HttpURLConnection? = null
        try {
            val wellnessArr = JSONArray()
            for (r in rows) {
                wellnessArr.put(JSONObject().apply {
                    put("date", r.date)
                    put("source", SOURCE)
                    put("metric_type", r.type)
                    put("value", r.value)
                    put("metadata", JSONObject())
                })
            }
            val workoutsArr = JSONArray()
            for ((i, w) in workouts.withIndex()) {
                workoutsArr.put(JSONObject().apply {
                    // Echoed back with the server's id (setWorkoutServerIds).
                    put("client_id", i)
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
                // Plain HTTP stays with the checked server (#194).
                if (url.protocol == "http") instanceFollowRedirects = false
            }
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(payload) }

            val code = conn.responseCode
            return if (code in 200..299) {
                Log.d(TAG, "server push ok: $code (${rows.size} metrics + ${workouts.size} workouts)")
                val body = conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
                try { JSONObject(body) } catch (_: Exception) { JSONObject() }
            } else {
                Log.w(TAG, "server push failed: HTTP $code")
                null
            }
        } catch (e: Exception) {
            Log.w(TAG, "server push failed: ${e.message}")
            return null
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

    /**
     * Write the values read, and return the ones that changed (null when
     * the write failed). As the JS
     * upsert (dbUpsertWellness): a value that is already there is left
     * alone, a new or changed one is marked pending, so it goes to the
     * server once (here or from the app) and an unchanged run sends nothing.
     */
    private fun writeToDb(
        ctx: Context,
        rows: List<WellnessRow>,
        workouts: List<WorkoutRow>
    ): Pair<List<WellnessRow>, List<WorkoutRow>>? {
        val changedRows = mutableListOf<WellnessRow>()
        val changedWorkouts = mutableListOf<WorkoutRow>()
        val dbFile = ctx.getDatabasePath(DB_FILENAME)
        if (!dbFile.exists()) {
            Log.d(TAG, "DB not found at ${dbFile.absolutePath}")
            return null
        }
        var db: SQLiteDatabase? = null
        try {
            db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            db.beginTransaction()
            try {
                val upsert = db.compileStatement(
                    """INSERT INTO wellness_data (user_id, date, source, metric_type, value, metadata)
                       VALUES (?, ?, ?, ?, ?, '{}')
                       ON CONFLICT(user_id, date, source, metric_type) DO UPDATE SET
                         value=excluded.value, metadata=excluded.metadata,
                         synced_at=datetime('now'), sync_status='pending'
                       WHERE wellness_data.value IS NOT excluded.value
                          OR wellness_data.metadata IS NOT excluded.metadata"""
                )
                for (r in rows) {
                    upsert.clearBindings()
                    upsert.bindLong(1, LOCAL_USER_ID.toLong())
                    upsert.bindString(2, r.date)
                    upsert.bindString(3, SOURCE)
                    upsert.bindString(4, r.type)
                    upsert.bindDouble(5, r.value)
                    if (upsert.executeUpdateDelete() > 0) changedRows.add(r)
                }
                // Workouts: one row per HC ExerciseSession, keyed by
                // (user_id, source, source_id). A later HC edit (e.g. calorie
                // refinement) updates the row; the same session read again
                // changes nothing. server_id stays NULL locally until the
                // JS sync push confirms it (dbSetWorkoutServerId).
                val workoutUpsert = db.compileStatement(
                    """INSERT INTO workouts (user_id, source, source_id, date, activity_type, activity_name, start_time, duration_ms, calories, has_gps, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
                       ON CONFLICT(user_id, source, source_id) DO UPDATE SET
                         date=excluded.date, activity_type=excluded.activity_type,
                         activity_name=excluded.activity_name, start_time=excluded.start_time,
                         duration_ms=excluded.duration_ms, calories=excluded.calories,
                         updated_at=datetime('now')
                       WHERE workouts.date IS NOT excluded.date
                          OR workouts.activity_type IS NOT excluded.activity_type
                          OR workouts.activity_name IS NOT excluded.activity_name
                          OR workouts.start_time IS NOT excluded.start_time
                          OR workouts.duration_ms IS NOT excluded.duration_ms
                          OR workouts.calories IS NOT excluded.calories"""
                )
                for (w in workouts) {
                    workoutUpsert.clearBindings()
                    workoutUpsert.bindLong(1, LOCAL_USER_ID.toLong())
                    workoutUpsert.bindString(2, SOURCE)
                    workoutUpsert.bindString(3, w.sourceId)
                    workoutUpsert.bindString(4, w.date)
                    if (w.activityType != null) workoutUpsert.bindString(5, w.activityType) else workoutUpsert.bindNull(5)
                    if (w.activityName != null) workoutUpsert.bindString(6, w.activityName) else workoutUpsert.bindNull(6)
                    if (w.startTime != null) workoutUpsert.bindString(7, w.startTime) else workoutUpsert.bindNull(7)
                    if (w.durationMs != null) workoutUpsert.bindLong(8, w.durationMs) else workoutUpsert.bindNull(8)
                    if (w.calories != null) workoutUpsert.bindLong(9, w.calories.toLong()) else workoutUpsert.bindNull(9)
                    if (workoutUpsert.executeUpdateDelete() > 0) changedWorkouts.add(w)
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        } catch (e: Exception) {
            Log.w(TAG, "DB write failed: ${e.message}")
            return null
        } finally {
            db?.close()
        }
        return Pair(changedRows, changedWorkouts)
    }

    /**
     * The server has these workouts: keep its id on each local row, as the
     * app's own push does (dbSetWorkoutServerId), so the app doesn't send
     * them a second time (it sends workouts without a server id).
     */
    private fun setWorkoutServerIds(ctx: Context, answer: JSONObject, workouts: List<WorkoutRow>) {
        val ids = answer.optJSONArray("workouts") ?: return
        if (ids.length() == 0) return
        val dbFile = ctx.getDatabasePath(DB_FILENAME)
        if (!dbFile.exists()) return
        var db: SQLiteDatabase? = null
        try {
            db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            for (i in 0 until ids.length()) {
                val o = ids.optJSONObject(i) ?: continue
                val w = workouts.getOrNull(o.optInt("client_id", -1)) ?: continue
                val serverId = o.optLong("server_id", 0L)
                if (serverId <= 0L) continue
                db.execSQL(
                    "UPDATE workouts SET server_id = ? WHERE user_id = ? AND source = ? AND source_id = ?",
                    arrayOf(serverId, LOCAL_USER_ID, SOURCE, w.sourceId)
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "workout server id update failed: ${e.message}")
        } finally {
            db?.close()
        }
    }

    /**
     * The server has these values: mark them synced, unless the app changed
     * one since (the value guard), so the app's own push doesn't send them
     * again.
     */
    private fun markSynced(ctx: Context, rows: List<WellnessRow>) {
        if (rows.isEmpty()) return
        val dbFile = ctx.getDatabasePath(DB_FILENAME)
        if (!dbFile.exists()) return
        var db: SQLiteDatabase? = null
        try {
            db = SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READWRITE)
            db.beginTransaction()
            try {
                for (r in rows) {
                    db.execSQL(
                        """UPDATE wellness_data SET sync_status = 'synced'
                           WHERE user_id = ? AND date = ? AND source = ? AND metric_type = ? AND value = ?""",
                        arrayOf(LOCAL_USER_ID, r.date, SOURCE, r.type, r.value)
                    )
                }
                db.setTransactionSuccessful()
            } finally {
                db.endTransaction()
            }
        } catch (e: Exception) {
            Log.w(TAG, "sync status update failed: ${e.message}")
        } finally {
            db?.close()
        }
    }
}
