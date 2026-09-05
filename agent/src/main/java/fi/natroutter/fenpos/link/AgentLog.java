package fi.natroutter.fenpos.link;

import fi.natroutter.foxlib.logger.FoxLogger;
import fi.natroutter.fenpos.enums.LogLevel;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Objects;

/**
 * Writes a line to this agent's own log and forwards it to the server.
 *
 * <p>Both, always, and in that order. The local log is the record that survives the link being
 * down, which is exactly when something interesting is usually happening; the forwarded copy is
 * what puts it in front of an operator who is not standing next to the machine. Losing either
 * would leave a real gap — a site with no console access, or a site whose internet is out.
 *
 * <p><strong>Forwarding is best effort.</strong> A line that cannot be sent is dropped rather
 * than buffered: an agent whose link is down has better uses for its memory than holding log
 * text, and the lines that matter operationally — a job failing, a port refusing to open — are
 * already reflected in job state and status reports, both of which are made whole again on the
 * next connection: the server settles the jobs this agent no longer holds, and the agent pushes a
 * fresh status report as soon as the configuration arrives.
 *
 * <p>Not every local log line comes through here. Only what an operator watching the panel would
 * act on is forwarded, because a log they cannot filter is a log they stop reading.
 */
public class AgentLog {

    private final FoxLogger logger;
    private final FrameSender sender;

    /**
     * @param logger the local log
     * @param sender the link to forward over
     */
    public AgentLog(FoxLogger logger, FrameSender sender) {
        this.logger = Objects.requireNonNull(logger, "logger");
        this.sender = Objects.requireNonNull(sender, "sender");
    }

    /**
     * Records something ordinary.
     *
     * @param message what happened
     * @param device  the device it concerns, or null
     */
    public void info(String message, String device) {
        logger.info(message);
        forward(LogLevel.INFO, message, device);
    }

    /**
     * Records something that went wrong without stopping the agent.
     *
     * @param message what happened
     * @param device  the device it concerns, or null
     */
    public void warn(String message, String device) {
        logger.warn(message);
        forward(LogLevel.WARN, message, device);
    }

    /**
     * Records a failure.
     *
     * @param message what happened
     * @param device  the device it concerns, or null
     */
    public void error(String message, String device) {
        logger.error(message);
        forward(LogLevel.ERROR, message, device);
    }

    /** Returns the local log, for messages that are not worth the server's attention. */
    public FoxLogger local() {
        return logger;
    }

    private void forward(LogLevel level, String message, String device) {
        sender.send(new Frames.LogLine(
                level,
                message,
                device,
                Instant.now().truncatedTo(ChronoUnit.MILLIS).toString()));
    }
}
