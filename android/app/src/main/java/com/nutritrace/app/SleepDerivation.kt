package com.nutritrace.app

import java.time.Instant
import java.time.ZoneId
import kotlin.math.floor

/**
 * SleepDerivation: one night of sleep from Health Connect SleepSession
 * records, for the background worker (#236).
 *
 * This is a line-for-line port of src/lib/sleep-sessions.js and the walk in
 * src/lib/sleep-quality.js, which the foreground sync runs. The two paths
 * must store the same numbers from the same records, so both are held to
 * scripts/fixtures/sleep-sessions.json: SleepDerivationFixturesTest is
 * generated from it, and a node test fails if the generated file is stale.
 * Change the rules in the JS and here together.
 *
 * Pure Kotlin and java.time only, so it runs in a plain JVM unit test. The
 * worker adapts SleepSessionRecord into [RawSession].
 *
 * The steps (see sleep-sessions.js for the reasoning behind each):
 *  1. normalize, clipping stages to their session;
 *  2. where sessions overlap, keep one app (stages first, then coverage,
 *     then the lower package name);
 *  3. sessions less than [NIGHT_GAP_MS] apart are one night, which belongs
 *     to the local date of its last minute;
 *  4. pick the night for the requested day with the most recorded sleep;
 *  5. duration is the union of its sessions; stage minutes and the Sleep
 *     Quality metrics come from the stage timeline with overlap removed.
 */
object SleepDerivation {

    /** Sessions closer together than this are one night. */
    const val NIGHT_GAP_MS = 3L * 60L * 60L * 1000L

    /** AndroidX SleepSessionRecord.STAGE_TYPE_* values. */
    const val STAGE_UNKNOWN = 0
    const val STAGE_AWAKE = 1
    const val STAGE_SLEEPING = 2
    const val STAGE_OUT_OF_BED = 3
    const val STAGE_LIGHT = 4
    const val STAGE_DEEP = 5
    const val STAGE_REM = 6
    const val STAGE_AWAKE_IN_BED = 7

    data class RawStage(val stage: Int, val start: Long, val end: Long)
    data class RawSession(
        val id: String,
        val origin: String,
        val start: Long,
        val end: Long,
        val stages: List<RawStage>
    )

    private data class Seg(val type: String, val start: Long, val end: Long, val id: String = "")
    private data class Sess(val id: String, val origin: String, val start: Long, val end: Long, val stages: List<Seg>)

    private val COUNTED = setOf("AWAKE", "LIGHT", "DEEP", "REM")

    /** One stage vocabulary; AWAKE_IN_BED counts as awake. Mirrors normalizeStage(). */
    fun stageName(stage: Int): String = when (stage) {
        STAGE_AWAKE, STAGE_AWAKE_IN_BED -> "AWAKE"
        STAGE_SLEEPING -> "SLEEPING"
        STAGE_OUT_OF_BED -> "OUT_OF_BED"
        STAGE_LIGHT -> "LIGHT"
        STAGE_DEEP -> "DEEP"
        STAGE_REM -> "REM"
        else -> "UNKNOWN"
    }

    fun localDate(ms: Long, zone: ZoneId): String =
        Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().toString()

    private fun normalize(raw: List<RawSession>): List<Sess> {
        val out = ArrayList<Sess>()
        for (r in raw) {
            if (r.end <= r.start) continue
            val stages = ArrayList<Seg>()
            for (st in r.stages) {
                val s = maxOf(st.start, r.start)
                val e = minOf(st.end, r.end)
                if (e <= s) continue
                stages.add(Seg(stageName(st.stage), s, e))
            }
            out.add(Sess(r.id, r.origin, r.start, r.end, stages))
        }
        return out
    }

    private val sessOrder = compareBy<Sess>({ it.start }, { it.end }, { it.id })
    private val segOrder = compareBy<Seg>({ it.start }, { it.end }, { it.id })

    /** Total length of the union of the sessions' spans. */
    private fun coveredMs(sessions: List<Sess>): Long {
        var total = 0L
        var curS = 0L
        var curE = Long.MIN_VALUE
        var open = false
        for (s in sessions.sortedWith(sessOrder)) {
            if (!open || s.start > curE) {
                if (open) total += curE - curS
                curS = s.start; curE = s.end; open = true
            } else if (s.end > curE) {
                curE = s.end
            }
        }
        if (open) total += curE - curS
        return total
    }

    /** Split sorted sessions into runs where each starts within `gap` of the run's end so far. */
    private fun runs(sorted: List<Sess>, gap: Long): List<List<Sess>> {
        val result = ArrayList<MutableList<Sess>>()
        var run: MutableList<Sess>? = null
        var runEnd = Long.MIN_VALUE
        for (s in sorted) {
            val current = run
            if (current != null && s.start - runEnd < gap) {
                current.add(s)
                if (s.end > runEnd) runEnd = s.end
            } else {
                val fresh = mutableListOf(s)
                run = fresh
                result.add(fresh)
                runEnd = s.end
            }
        }
        return result
    }

    private fun resolveOverlaps(sessions: List<Sess>): List<Sess> {
        val kept = ArrayList<Sess>()
        for (group in runs(sessions.sortedWith(sessOrder), 0L)) {
            val origins = group.map { it.origin }.distinct()
            if (origins.size == 1) { kept.addAll(group); continue }
            var bestOrigin = ""
            var bestStaged = -1
            var bestCovered = -1L
            for (origin in origins) {
                val mine = group.filter { it.origin == origin }
                val covered = coveredMs(mine)
                val staged = if (mine.any { it.stages.isNotEmpty() }) 1 else 0
                if (bestStaged < 0
                    || staged > bestStaged
                    || (staged == bestStaged && covered > bestCovered)
                    || (staged == bestStaged && covered == bestCovered && origin < bestOrigin)) {
                    bestOrigin = origin; bestStaged = staged; bestCovered = covered
                }
            }
            kept.addAll(group.filter { it.origin == bestOrigin })
        }
        return kept.sortedWith(sessOrder)
    }

    private fun mergedStages(night: List<Sess>): List<Seg> {
        val all = night.flatMap { it.stages }.sortedWith(segOrder)
        val out = ArrayList<Seg>()
        var cursor = Long.MIN_VALUE
        for (seg in all) {
            val start = maxOf(seg.start, cursor)
            if (seg.end <= start) continue
            out.add(Seg(seg.type, start, seg.end))
            cursor = seg.end
        }
        return out
    }

    private fun roundMin(ms: Long): Int = Math.round(ms / 60000.0).toInt()

    /**
     * The sleep metrics for `dateStr` (the day you woke up) under the
     * canonical Wellness ids. Empty when no night ends that day.
     */
    fun derive(raw: List<RawSession>, dateStr: String, zone: ZoneId): Map<String, Number> {
        val sessions = resolveOverlaps(normalize(raw))

        var night: List<Sess>? = null
        var nightCovered = -1L
        var nightEnd = Long.MIN_VALUE
        for (run in runs(sessions, NIGHT_GAP_MS)) {
            val end = run.maxOf { it.end }
            if (localDate(end, zone) != dateStr) continue
            val covered = coveredMs(run)
            if (covered > nightCovered || (covered == nightCovered && end > nightEnd)) {
                night = run; nightCovered = covered; nightEnd = end
            }
        }
        val chosen = night ?: return emptyMap()

        val metrics = LinkedHashMap<String, Number>()
        metrics["sleep_duration_min"] = roundMin(nightCovered)

        val segs = mergedStages(chosen).filter { it.type in COUNTED }
        if (segs.isEmpty()) return metrics

        var deep = 0L; var light = 0L; var rem = 0L; var awake = 0L
        for (s in segs) {
            val d = s.end - s.start
            when (s.type) {
                "DEEP" -> deep += d
                "LIGHT" -> light += d
                "REM" -> rem += d
                "AWAKE" -> awake += d
            }
        }
        metrics["sleep_deep_min"] = roundMin(deep)
        metrics["sleep_light_min"] = roundMin(light)
        metrics["sleep_rem_min"] = roundMin(rem)
        metrics["sleep_wake_min"] = roundMin(awake)

        val q = quality(segs)
        metrics["sleep_restlessness_min"] = q.restlessnessMin
        metrics["sleep_interruptions_min"] = q.interruptionsMin
        metrics["sleep_full_awakenings"] = q.fullAwakenings
        q.timeToSoundSleep?.let { metrics["sleep_time_to_fall_asleep_min"] = it }
        q.soundSleepMin?.let { metrics["sleep_sound_sleep_min"] = it }
        return metrics
    }

    private data class Quality(
        val restlessnessMin: Int,
        val interruptionsMin: Int,
        val fullAwakenings: Int,
        val timeToSoundSleep: Int?,
        val soundSleepMin: Int?
    )

    /** Port of deriveSleepQuality() in src/lib/sleep-quality.js. Keep them identical. */
    private fun quality(segs: List<Seg>): Quality {
        val fullAwakeMin = 5.0
        val durMin = { s: Seg -> (s.end - s.start) / 60000.0 }

        // First pass: the morning wake-up, the last AWAKE >= 5 min followed
        // by less than 5 min of sleep. It is skipped, not an interruption.
        var lastAwakeBigIdx = -1
        for (i in segs.indices.reversed()) {
            val seg = segs[i]
            if (seg.type != "AWAKE") continue
            if (durMin(seg) < fullAwakeMin) continue
            var postSleepMin = 0.0
            for (j in i + 1 until segs.size) {
                val s2 = segs[j]
                if (s2.type == "AWAKE") break
                postSleepMin += durMin(s2)
            }
            if (postSleepMin < fullAwakeMin) {
                lastAwakeBigIdx = i
                break
            }
        }

        val briefLightMax = 5.0
        val ttssSettlingCap = 10.0
        var interruptionsMin = 0
        var fullAwakenings = 0
        var restlessnessMin = 0
        var firstAsleepStart: Long? = null
        var firstDeepStart: Long? = null
        var soundSleepRaw = 0.0
        var firstAwakeSeen = false
        for (i in segs.indices) {
            val seg = segs[i]
            val d = durMin(seg)
            when (seg.type) {
                "AWAKE" -> {
                    // First AWAKE >= 5 min is settling in; counts toward time
                    // to sound sleep only when it is short.
                    if (!firstAwakeSeen) {
                        firstAwakeSeen = true
                        if (d >= fullAwakeMin) {
                            if (d <= ttssSettlingCap && firstAsleepStart == null) firstAsleepStart = seg.start
                            continue
                        }
                    }
                    if (i == lastAwakeBigIdx) continue
                    if (d >= fullAwakeMin) {
                        interruptionsMin += Math.round(d).toInt()
                        fullAwakenings++
                    } else {
                        restlessnessMin += floor(d).toInt()
                    }
                }
                "DEEP", "REM" -> {
                    soundSleepRaw += d
                    if (firstAsleepStart == null) firstAsleepStart = seg.start
                    if (seg.type == "DEEP" && firstDeepStart == null) firstDeepStart = seg.start
                }
                "LIGHT" -> {
                    if (firstAsleepStart == null) firstAsleepStart = seg.start
                    if (d < briefLightMax) soundSleepRaw += d
                }
            }
        }
        val fa = firstAsleepStart
        val fd = firstDeepStart
        val ttss = if (fa != null && fd != null && fd > fa) Math.round((fd - fa) / 60000.0).toInt() else null
        val sound = if (soundSleepRaw > 0) Math.round(soundSleepRaw).toInt() else null
        return Quality(restlessnessMin, interruptionsMin, fullAwakenings, ttss, sound)
    }
}
