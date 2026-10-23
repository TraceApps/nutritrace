package com.nutritrace.app

import java.math.BigDecimal
import java.math.RoundingMode
import java.time.Instant
import java.time.LocalDate

/**
 * Which days a Health Connect read covers (#294). The Kotlin side of
 * catchUpFrom / catchUpDue in src/lib/health-connect.js, held to the same
 * cases by scripts/fixtures/hc-catch-up.json (HealthConnectDaysTest here,
 * scripts/health-connect-days.test.js there), so the foreground sync and
 * the background worker read the same days.
 *
 * A catch-up re-reads the last 7 days at most once an hour; the first one
 * reads 30 days, all Health Connect lets an app read from before it was
 * given access; after a longer absence it reads back to the last day a
 * catch-up covered, up to 30 days. Both paths keep the last catch-up in
 * sync_meta: 'hc_catchup_at' (when it ran) and 'hc_catchup_day' (the day
 * it covered up to, only when every read worked).
 */
object HealthConnectDays {
    const val HISTORY_DAYS = 30L
    const val CATCH_UP_DAYS = 7L
    const val CATCH_UP_EVERY_MS = 60L * 60L * 1000L

    const val META_AT = "hc_catchup_at"
    const val META_DAY = "hc_catchup_day"

    fun catchUpFrom(today: LocalDate, lastDay: String?): LocalDate {
        val oldest = today.minusDays(HISTORY_DAYS - 1)
        val recent = today.minusDays(CATCH_UP_DAYS - 1)
        val last = try { if (lastDay.isNullOrBlank()) null else LocalDate.parse(lastDay) } catch (_: Exception) { null }
            ?: return oldest
        val from = if (last.isBefore(recent)) last else recent
        return if (from.isBefore(oldest)) oldest else from
    }

    fun catchUpDue(lastAt: String?, now: Instant): Boolean {
        val t = try { if (lastAt.isNullOrBlank()) null else Instant.parse(lastAt) } catch (_: Exception) { null }
            ?: return true
        val nowMs = now.toEpochMilli()
        val tMs = t.toEpochMilli()
        return tMs > nowMs || nowMs - tMs >= CATCH_UP_EVERY_MS
    }

    /**
     * Rounds as JavaScript's toFixed(places) does (the exact value of the
     * double, half up), so the worker and the foreground sync store the
     * same number and neither sees the other's value as a change.
     */
    fun round(v: Double, places: Int): Double =
        BigDecimal(v).setScale(places, RoundingMode.HALF_UP).toDouble()
}
