package fi.natroutter.fenpos.device;

import fi.natroutter.fenpos.enums.Codepage;
import fi.natroutter.fenpos.enums.Linefeed;
import fi.natroutter.fenpos.enums.UnsupportedPolicy;

/**
 * Printing settings for one device.
 * <p>
 * {@link #columns()} and {@link #codepage()} come from the server, which needs them itself to
 * wrap and validate; the rest describe how the agent composes a job of its own, which is a
 * decision the server has no part in.
 *
 * @param columns          printable character columns at normal width; wrapping divides
 *                         this by a span's width multiplier
 * @param codepage         character table the printer is switched to for every job
 * @param onUnsupported    what to do with a character the codepage cannot represent
 * @param defaultWrap      whether locally composed jobs are wrapped
 * @param defaultLinefeed  terminator written after each line of a locally composed job
 */
public record PrintSettings(
        int columns,
        Codepage codepage,
        UnsupportedPolicy onUnsupported,
        boolean defaultWrap,
        Linefeed defaultLinefeed) {
}
