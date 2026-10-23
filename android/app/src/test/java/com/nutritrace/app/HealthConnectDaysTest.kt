// Cases from scripts/fixtures/hc-catch-up.json (#294); scripts/health-connect-days.test.js
// checks that every fixture case is here, so the worker and the foreground
// sync read the same days.
package com.nutritrace.app

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

class HealthConnectDaysTest {
    private fun from(today: String, lastDay: String?, expect: String) =
        assertEquals("catchUpFrom($today, $lastDay)", LocalDate.parse(expect), HealthConnectDays.catchUpFrom(LocalDate.parse(today), lastDay))

    private fun due(lastAt: String?, now: String, expect: Boolean) =
        assertEquals("catchUpDue($lastAt, $now)", expect, HealthConnectDays.catchUpDue(lastAt, Instant.parse(now)))

    @Test
    fun catchUpFromFixtures() {
        from("2026-10-22", null, "2026-09-23") // first catch-up reads 30 days
        from("2026-10-22", "yesterday", "2026-09-23") // unreadable last day reads 30 days
        from("2026-10-22", "2026-10-22", "2026-10-16") // caught up today: the last 7 days
        from("2026-10-22", "2026-10-21", "2026-10-16") // caught up yesterday: the last 7 days
        from("2026-10-22", "2026-10-10", "2026-10-10") // away for 12 days: back to the last day covered
        from("2026-10-22", "2026-08-01", "2026-09-23") // away for 2 months: 30 days at most
        from("2028-03-05", null, "2028-02-05") // across a month and a leap day
        from("2027-01-03", "2027-01-02", "2026-12-28") // across a year
    }

    @Test
    fun catchUpDueFixtures() {
        due(null, "2026-10-22T12:00:00Z", true) // never ran
        due("soon", "2026-10-22T12:00:00Z", true) // unreadable time
        due("2026-10-22T11:01:00Z", "2026-10-22T12:00:00Z", false) // 59 minutes ago
        due("2026-10-22T11:00:00Z", "2026-10-22T12:00:00Z", true) // an hour ago
        due("2026-10-22T13:00:00Z", "2026-10-22T12:00:00Z", true) // in the future (clock moved back)
    }

    @Test
    fun roundsLikeJavaScriptToFixed() {
        assertEquals(1.24, HealthConnectDays.round(1.235, 2), 0.0) // 1.235 is 1.23500000000000009769... as a double
        assertEquals(1.0, HealthConnectDays.round(1.005, 2), 0.0)  // 1.00499999999999989... (JS: (1.005).toFixed(2) == "1.00")
        assertEquals(80.5, HealthConnectDays.round(80.46, 1), 0.0)
        assertEquals(79.9, HealthConnectDays.round(79.94, 1), 0.0)
    }
}
