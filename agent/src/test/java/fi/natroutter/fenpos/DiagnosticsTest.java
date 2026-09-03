package fi.natroutter.fenpos;

import fi.natroutter.foxlib.logger.FoxLogger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The verbose-logging switch.
 * <p>
 * What is asserted is the difference it makes to a logged failure, because that difference is the
 * whole point: off, an operator sees one line; on, a developer sees where it came from.
 */
class DiagnosticsTest {

    private final List<String> lines = new ArrayList<>();

    /** Console output on, routed into a list: what is asserted is what the sink received. */
    private final FoxLogger logger = new FoxLogger.Builder()
            .setLoggerName("test")
            .setSaveLogs(false)
            .setConsoleLog(true)
            .setPrintter(lines::add)
            .build();

    @AfterEach
    void restore() {
        Diagnostics.enable(false);
    }

    @Test
    void parsesTheUsualSpellingsOfOn() {
        assertTrue(Diagnostics.parse("1"));
        assertTrue(Diagnostics.parse("true"));
        assertTrue(Diagnostics.parse(" TRUE "));
        assertTrue(Diagnostics.parse("yes"));
        assertTrue(Diagnostics.parse("On"));
    }

    @Test
    void anythingElseIsOff() {
        assertFalse(Diagnostics.parse(null));
        assertFalse(Diagnostics.parse(""));
        assertFalse(Diagnostics.parse("0"));
        assertFalse(Diagnostics.parse("false"));
        assertFalse(Diagnostics.parse("debug"));
    }

    @Test
    void describesAFailureByItsMessageAloneWhenOff() {
        Diagnostics.enable(false);
        IOException failure = new IOException("connection refused", new RuntimeException("root"));

        String described = Diagnostics.describe(failure);

        assertEquals("connection refused", described);
        assertEquals("", Diagnostics.stackTrace(failure));
    }

    @Test
    void fallsBackToTheClassWhenAFailureHasNoMessage() {
        Diagnostics.enable(false);

        assertEquals("java.lang.IllegalStateException", Diagnostics.describe(new IllegalStateException()));
    }

    @Test
    void appendsTheTraceAndItsCausesWhenOn() {
        Diagnostics.enable(true);
        IOException failure = new IOException("connection refused", new RuntimeException("root"));

        String described = Diagnostics.describe(failure);

        assertTrue(described.startsWith("connection refused" + System.lineSeparator()));
        assertTrue(described.contains("at " + DiagnosticsTest.class.getName()));
        assertTrue(described.contains("Caused by: java.lang.RuntimeException: root"));
    }

    @Test
    void debugLinesAreWrittenOnlyWhenOn() {
        Diagnostics.enable(false);
        Diagnostics.debug(logger, "quiet");
        assertTrue(lines.isEmpty());

        Diagnostics.enable(true);
        Diagnostics.debug(logger, "loud");
        assertEquals(1, lines.size());
        assertTrue(lines.get(0).contains("[debug] loud"));
    }
}
