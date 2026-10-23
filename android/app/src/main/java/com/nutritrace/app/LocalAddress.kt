package com.nutritrace.app

import java.math.BigInteger

/**
 * Kotlin copy of src/lib/local-address.js, for HealthConnectSyncWorker (#194).
 *
 * Plain http:// only to a server that can't be on the public internet:
 * private IPv4 (10/8, 172.16/12, 192.168/16), Tailscale/CGNAT 100.64/10,
 * loopback 127/8, link-local 169.254/16, IPv6 fc00::/7, fe80::/10 and ::1,
 * a bare one-word name, or a name ending in .local, .home.arpa, .internal
 * or .lan. Everything else over http:// is refused; https:// is fine.
 *
 * The address is read the way the WebView's URL parser (the WHATWG URL
 * standard) reads it, so both copies give the same answer for the same
 * text: scripts/fixtures/local-address-cases.json runs against both
 * (LocalAddressFixturesTest.kt is generated from it). One deliberate
 * difference: a host that isn't plain ASCII once percent-decoded (an
 * international name, fullwidth digits) is refused here, because Java's
 * IDN (IDNA2003) and the WebView (UTS 46) can turn it into different hosts.
 *
 * The worker connects to the URL rebuilt from what was checked, never the
 * raw text, and only when that rebuilt URL is exactly the one the app
 * confirmed (canonicalServerBase in src/lib/plain-http.js), so it can't
 * reach a host the two parsers read differently.
 */
object LocalAddress {
    private val LOCAL_SUFFIXES = listOf(".local", ".home.arpa", ".internal", ".lan")
    private val TWO_FIFTY_SIX: BigInteger = BigInteger.valueOf(256)

    /** An http(s) URL read as the WHATWG parser reads it. `host` is serialized (IPv6 in brackets). */
    data class Parsed(val scheme: String, val host: String, val port: Int?, val path: String) {
        /** scheme://host[:port]path, path without a trailing slash. */
        fun base(): String = "$scheme://$host" + (port?.let { ":$it" } ?: "") + path.trimEnd('/')
    }

    /** "https", "local" (http:// on your own network), "public" (refused) or "invalid". */
    fun classify(raw: String?): String {
        val p = parse(raw) ?: return "invalid"
        if (p.scheme == "https") return "https"
        return if (isLocalHostname(p.host)) "local" else "public"
    }

    /**
     * Where the background worker may send for this server, or null when it
     * may not: https:// as saved; plain http:// only to a local server whose
     * rebuilt address is exactly the one the app confirmed (sync_meta
     * 'server_http_ok', written by the app as the WebView's URL parser
     * writes it).
     */
    fun workerBase(serverUrl: String?, confirmedBase: String?): String? {
        if (serverUrl.isNullOrBlank()) return null
        val p = parse(serverUrl) ?: return null
        return when {
            p.scheme == "https" -> serverUrl
            p.scheme == "http" && isLocalHostname(p.host) && !confirmedBase.isNullOrEmpty() && p.base() == confirmedBase -> p.base()
            else -> null
        }
    }

    /** Whether a serialized host (as Parsed.host) is on your own network. */
    fun isLocalHostname(hostname: String): Boolean {
        val host = hostname.lowercase()
        if (host.isEmpty()) return false
        if (host.startsWith("[") && host.endsWith("]")) {
            val v6 = parseIPv6(host.substring(1, host.length - 1)) ?: return false
            return isLocalIPv6(v6)
        }
        val v4 = dottedIPv4(host)
        if (v4 != null) return isLocalIPv4(v4)
        if (!host.contains('.')) return true
        val name = if (host.endsWith(".")) host.dropLast(1) else host
        return LOCAL_SUFFIXES.any { name.length > it.length && name.endsWith(it) }
    }

    /** The WHATWG URL parser, cut down to what an absolute http(s) URL needs. */
    fun parse(raw: String?): Parsed? {
        if (raw == null) return null
        val s = raw.trim { it <= ' ' }.filterNot { it == '\t' || it == '\n' || it == '\r' }
        val colon = s.indexOf(':')
        if (colon <= 0) return null
        val schemeText = s.substring(0, colon)
        if (!isAsciiAlpha(schemeText[0])) return null
        if (!schemeText.all { isAsciiAlpha(it) || it in '0'..'9' || it == '+' || it == '-' || it == '.' }) return null
        val scheme = schemeText.lowercase()
        if (scheme != "http" && scheme != "https") return null

        var i = colon + 1
        while (i < s.length && (s[i] == '/' || s[i] == '\\')) i++
        val rest = s.substring(i)
        val end = rest.indexOfFirst { it == '/' || it == '\\' || it == '?' || it == '#' }.let { if (it < 0) rest.length else it }
        val authority = rest.substring(0, end)
        val tail = rest.substring(end)

        val hostPort = authority.substring(authority.lastIndexOf('@') + 1)
        var inBrackets = false
        var split = -1
        for ((k, c) in hostPort.withIndex()) {
            if (c == '[') inBrackets = true
            else if (c == ']') inBrackets = false
            else if (c == ':' && !inBrackets) { split = k; break }
        }
        val hostText = if (split >= 0) hostPort.substring(0, split) else hostPort
        val portText = if (split >= 0) hostPort.substring(split + 1) else ""
        if (hostText.isEmpty()) return null
        if (!portText.all { it in '0'..'9' }) return null
        var port: Int? = null
        if (portText.isNotEmpty()) {
            val n = BigInteger(portText)
            if (n > BigInteger.valueOf(65535)) return null
            port = n.toInt()
        }
        if ((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) port = null

        val host = parseHost(hostText) ?: return null
        val q = tail.indexOfFirst { it == '?' || it == '#' }.let { if (it < 0) tail.length else it }
        val path = tail.substring(0, q).replace('\\', '/')
        return Parsed(scheme, host, port, path)
    }

    private fun isAsciiAlpha(c: Char) = c in 'a'..'z' || c in 'A'..'Z'
    private fun isAsciiDigit(c: Char) = c in '0'..'9'
    private fun hexValue(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }

    private fun parseHost(input: String): String? {
        if (input.startsWith("[")) {
            if (!input.endsWith("]")) return null
            val pieces = parseIPv6(input.substring(1, input.length - 1)) ?: return null
            return "[" + serializeIPv6(pieces) + "]"
        }
        val decoded = percentDecode(input)
        val ascii = domainToAscii(decoded) ?: return null
        if (ascii.isEmpty()) return null
        if (ascii.any { forbiddenDomainCodePoint(it) }) return null
        if (endsInNumber(ascii)) {
            val v4 = parseIPv4(ascii) ?: return null
            return serializeIPv4(v4)
        }
        return ascii
    }

    private fun percentDecode(input: String): String {
        val bytes = input.toByteArray(Charsets.UTF_8)
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        fun hexAt(at: Int) = hexValue((bytes[at].toInt() and 0xFF).toChar())
        while (i < bytes.size) {
            val b = bytes[i]
            if (b == '%'.code.toByte() && i + 2 < bytes.size && hexAt(i + 1) >= 0 && hexAt(i + 2) >= 0) {
                out.write(hexAt(i + 1) * 16 + hexAt(i + 2))
                i += 3
            } else {
                out.write(b.toInt())
                i++
            }
        }
        return String(out.toByteArray(), Charsets.UTF_8)
    }

    // ASCII only (see the class comment): an international host is refused.
    private fun domainToAscii(domain: String): String? =
        if (domain.all { it.code < 0x80 }) domain.lowercase() else null

    private fun forbiddenDomainCodePoint(c: Char): Boolean =
        c.code <= 0x20 || c.code == 0x7F || c in "#%/:<>?@[\\]^|"

    private fun endsInNumber(host: String): Boolean {
        val parts = host.split('.').toMutableList()
        if (parts.last().isEmpty()) {
            if (parts.size == 1) return false
            parts.removeAt(parts.size - 1)
        }
        val last = parts.last()
        if (last.isNotEmpty() && last.all { isAsciiDigit(it) }) return true
        return parseIPv4Number(last) != null
    }

    private fun parseIPv4Number(input: String): BigInteger? {
        if (input.isEmpty()) return null
        var text = input
        var radix = 10
        if (text.length >= 2 && (text.startsWith("0x") || text.startsWith("0X"))) {
            text = text.substring(2); radix = 16
        } else if (text.length >= 2 && text[0] == '0') {
            text = text.substring(1); radix = 8
        }
        if (text.isEmpty()) return BigInteger.ZERO
        val ok = text.all { c ->
            when (radix) {
                16 -> hexValue(c) >= 0
                8 -> c in '0'..'7'
                else -> isAsciiDigit(c)
            }
        }
        return if (ok) BigInteger(text, radix) else null
    }

    private fun parseIPv4(input: String): BigInteger? {
        val parts = input.split('.').toMutableList()
        if (parts.last().isEmpty() && parts.size > 1) parts.removeAt(parts.size - 1)
        if (parts.size > 4) return null
        val numbers = parts.map { parseIPv4Number(it) ?: return null }
        if (numbers.dropLast(1).any { it > BigInteger.valueOf(255) }) return null
        if (numbers.last() >= TWO_FIFTY_SIX.pow(5 - numbers.size)) return null
        var ipv4 = numbers.last()
        for ((k, n) in numbers.dropLast(1).withIndex()) ipv4 = ipv4.add(n.multiply(TWO_FIFTY_SIX.pow(3 - k)))
        return ipv4
    }

    private fun serializeIPv4(n: BigInteger): String {
        val v = n.toLong()
        return listOf(24, 16, 8, 0).joinToString(".") { ((v shr it) and 0xFF).toString() }
    }

    // Canonical dotted-quad only, as parse() leaves an IPv4 host.
    private fun dottedIPv4(host: String): IntArray? {
        val parts = host.split('.')
        if (parts.size != 4) return null
        val out = IntArray(4)
        for ((k, p) in parts.withIndex()) {
            if (p.isEmpty() || p.length > 3 || !p.all { isAsciiDigit(it) }) return null
            val n = p.toInt()
            if (n > 255) return null
            out[k] = n
        }
        return out
    }

    private fun isLocalIPv4(a: IntArray): Boolean {
        val (x, y) = a[0] to a[1]
        return x == 10 ||
            (x == 172 && y in 16..31) ||
            (x == 192 && y == 168) ||
            (x == 100 && y in 64..127) ||
            x == 127 ||
            (x == 169 && y == 254)
    }

    private fun isLocalIPv6(p: IntArray): Boolean {
        if ((p[0] and 0xfe00) == 0xfc00) return true
        if ((p[0] and 0xffc0) == 0xfe80) return true
        return (0 until 7).all { p[it] == 0 } && p[7] == 1
    }

    /** The WHATWG IPv6 parser: eight pieces, or null. */
    private fun parseIPv6(input: String): IntArray? {
        val address = IntArray(8)
        var pieceIndex = 0
        var compress: Int? = null
        var pointer = 0
        val len = input.length
        fun c(at: Int = pointer): Char? = if (at < len) input[at] else null

        if (c() == ':') {
            if (c(pointer + 1) != ':') return null
            pointer += 2
            pieceIndex++
            compress = pieceIndex
        }
        while (c() != null) {
            if (pieceIndex == 8) return null
            if (c() == ':') {
                if (compress != null) return null
                pointer++
                pieceIndex++
                compress = pieceIndex
                continue
            }
            var value = 0
            var length = 0
            while (length < 4 && c() != null && hexValue(c()!!) >= 0) {
                value = value * 0x10 + hexValue(c()!!)
                pointer++
                length++
            }
            if (c() == '.') {
                if (length == 0) return null
                pointer -= length
                if (pieceIndex > 6) return null
                var numbersSeen = 0
                while (c() != null) {
                    var ipv4Piece: Int? = null
                    if (numbersSeen > 0) {
                        if (c() == '.' && numbersSeen < 4) pointer++ else return null
                    }
                    if (c() == null || !isAsciiDigit(c()!!)) return null
                    while (c() != null && isAsciiDigit(c()!!)) {
                        val number = c()!! - '0'
                        ipv4Piece = when (ipv4Piece) {
                            null -> number
                            0 -> return null
                            else -> ipv4Piece!! * 10 + number
                        }
                        if (ipv4Piece > 255) return null
                        pointer++
                    }
                    address[pieceIndex] = address[pieceIndex] * 0x100 + ipv4Piece!!
                    numbersSeen++
                    if (numbersSeen == 2 || numbersSeen == 4) pieceIndex++
                }
                if (numbersSeen != 4) return null
                break
            } else if (c() == ':') {
                pointer++
                if (c() == null) return null
            } else if (c() != null) {
                return null
            }
            address[pieceIndex] = value
            pieceIndex++
        }
        if (compress != null) {
            var swaps = pieceIndex - compress
            pieceIndex = 7
            while (pieceIndex != 0 && swaps > 0) {
                val other = compress + swaps - 1
                val tmp = address[pieceIndex]
                address[pieceIndex] = address[other]
                address[other] = tmp
                pieceIndex--
                swaps--
            }
        } else if (pieceIndex != 8) {
            return null
        }
        return address
    }

    private fun serializeIPv6(address: IntArray): String {
        // The first longest run of two or more zero pieces becomes "::".
        var compress = -1
        var bestLen = 1
        var k = 0
        while (k < 8) {
            if (address[k] == 0) {
                var j = k
                while (j < 8 && address[j] == 0) j++
                if (j - k > bestLen) { bestLen = j - k; compress = k }
                k = j
            } else k++
        }
        val out = StringBuilder()
        var ignore0 = false
        for (i in 0 until 8) {
            if (ignore0 && address[i] == 0) continue
            ignore0 = false
            if (compress == i) {
                out.append(if (i == 0) "::" else ":")
                ignore0 = true
                continue
            }
            out.append(Integer.toHexString(address[i]))
            if (i != 7) out.append(':')
        }
        return out.toString()
    }
}
