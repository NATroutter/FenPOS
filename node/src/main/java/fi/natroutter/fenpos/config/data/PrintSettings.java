package fi.natroutter.fenpos.config.data;

import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;

/**
 * Fully resolved printing settings for one device.
 * <p>
 * This is everything the compile pipeline needs to turn a request into bytes, with no
 * serial or HTTP concerns attached.
 *
 * @param columns          printable character columns at normal width; wrapping divides
 *                         this by a span's width multiplier
 * @param codepage         character table the printer is switched to for every job
 * @param onUnsupported    what to do with a character the codepage cannot represent
 * @param defaultWrap      value for a request that omits {@code wrap}
 * @param defaultLinefeed  value for a request that omits {@code linefeed}
 */
public record PrintSettings(
        int columns,
        Codepage codepage,
        UnsupportedPolicy onUnsupported,
        boolean defaultWrap,
        Linefeed defaultLinefeed) {
}
