package fi.natroutter.fenpos;

import fi.natroutter.foxlib.logger.FoxLogger;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.Locale;

/**
 * The verbose-logging switch, read from the {@value #VARIABLE} environment variable.
 * <p>
 * The agent's ordinary log is written for an operator: one line per event, the reason in plain
 * words, no stack traces. That is the right default for a box in a shop, and the wrong one for
 * the day something breaks in a way the words do not explain. The link failing behind a reverse
 * proxy is the case that shaped this: for hours the log said only that the handshake failed,
 * while the status code, the exception chain and the request it made were all discarded before
 * they reached the log.
 * <p>
 * With the variable set, three things change. Every logged exception carries its full stack
 * trace, causes included. Points that are silent when they work — a connection attempt, a frame
 * in either direction — say what they did. And the JDK's HTTP client reports each request it
 * makes and the status it got back, which is what shows a proxy answering in the server's place.
 * <p>
 * Headers are deliberately not part of that last one: the link's request carries the agent's
 * credential in a header, and a debug flag must never be the way it ends up in a log file.
 * <p>
 * Accepted values are {@code 1}, {@code true}, {@code yes} and {@code on}, in any case. Anything
 * else, including unset, is off.
 */
public final class Diagnostics {

    /** Environment variable that turns verbose logging on. */
    public static final String VARIABLE = "FENPOS_DEBUG";

    /** JDK property that makes its HTTP client log what it does. */
    private static final String HTTP_CLIENT_LOG_PROPERTY = "jdk.httpclient.HttpClient.log";

    /** Request lines and statuses only; {@code headers} would log the bearer token. */
    private static final String HTTP_CLIENT_LOG_VALUE = "requests,errors";

    private static volatile boolean enabled = parse(System.getenv(VARIABLE));

    private Diagnostics() {
    }

    /** Whether verbose logging is on. */
    public static boolean enabled() {
        return enabled;
    }

    /**
     * Turns verbose logging on or off for this process.
     * <p>
     * Package-private: the environment decides in the running agent, and this exists so a test
     * can exercise both sides without an environment of its own.
     */
    static void enable(boolean on) {
        enabled = on;
    }

    /**
     * Interprets the variable's value.
     *
     * @param raw the value as set, or null when unset
     * @return whether it means on
     */
    public static boolean parse(String raw) {
        if (raw == null) {
            return false;
        }
        return switch (raw.trim().toLowerCase(Locale.ROOT)) {
            case "1", "true", "yes", "on" -> true;
            default -> false;
        };
    }

    /**
     * Applies the process-wide effects of the switch and says so.
     * <p>
     * Called once at startup, before any HTTP client is built: the JDK reads its logging property
     * when the client classes initialise, so setting it afterwards does nothing. An operator who
     * set the property by hand on the command line keeps their own value.
     *
     * @param logger where to announce the mode
     */
    public static void configureProcess(FoxLogger logger) {
        if (!enabled) {
            return;
        }
        if (System.getProperty(HTTP_CLIENT_LOG_PROPERTY) == null) {
            System.setProperty(HTTP_CLIENT_LOG_PROPERTY, HTTP_CLIENT_LOG_VALUE);
        }
        logger.info("Verbose logging is on (" + VARIABLE + "): errors carry stack traces, the link "
                + "reports every attempt and frame, and each HTTP request is logged with its status");
    }

    /**
     * Describes a failure for the log: its message, and with verbose logging on, its stack trace.
     * <p>
     * The message alone is what an operator needs day to day. The trace is what a developer needs
     * when the message is not enough, and the switch is what decides who is reading.
     *
     * @param error the failure
     * @return the description, possibly spanning several lines
     */
    public static String describe(Throwable error) {
        if (error == null) {
            return "unknown error";
        }
        String summary = error.getMessage() == null ? error.toString() : error.getMessage();
        return summary + stackTrace(error);
    }

    /**
     * The stack trace of a failure, causes included, when verbose logging is on.
     * <p>
     * For callers that build their own one-line summary and want the trace appended to it. Starts
     * with a line break so it can follow a message directly.
     *
     * @param error the failure
     * @return the trace, or an empty string when verbose logging is off
     */
    public static String stackTrace(Throwable error) {
        if (!enabled || error == null) {
            return "";
        }
        StringWriter buffer = new StringWriter();
        error.printStackTrace(new PrintWriter(buffer));
        return System.lineSeparator() + buffer.toString().stripTrailing();
    }

    /**
     * Logs a line that only matters when someone is debugging.
     * <p>
     * Costs nothing when verbose logging is off beyond building the string, so callers should
     * keep the message cheap: no rendering of frames or dumps of state that are only ever read
     * with the switch on.
     *
     * @param logger  the log to write to
     * @param message what happened
     */
    public static void debug(FoxLogger logger, String message) {
        if (enabled) {
            logger.info("[debug] " + message);
        }
    }
}
