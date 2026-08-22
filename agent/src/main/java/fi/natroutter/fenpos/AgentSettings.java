package fi.natroutter.fenpos;

import java.time.Duration;

/**
 * Agent-side timing knobs the server may override, pushed alongside
 * {@link fi.natroutter.fenpos.print.JobSettings} in every {@code config.sync}.
 * <p>
 * Each of these previously lived as a fixed constant on {@link FenPOSAgent} or
 * {@link fi.natroutter.fenpos.print.PrintQueue}. They are grouped into one record and carried
 * together because all three cross the wire on the same frame — widening {@code config.sync}
 * a second time for the sake of keeping them apart would cost more than the grouping does.
 *
 * @param statusInterval   how often device state is pushed even when nothing has changed
 * @param evictionInterval how often expired job records are swept
 * @param queuePoll        how long an idle print queue waits before checking for work again
 */
public record AgentSettings(Duration statusInterval, Duration evictionInterval, Duration queuePoll) {

    /**
     * Settings used before the first {@code config.sync} arrives, and by an agent talking to a
     * server old enough not to send them.
     * <p>
     * Matches the fixed values this agent used before these became configurable, so an upgrade
     * changes nothing for an install that never touches them.
     */
    public static final AgentSettings DEFAULTS =
            new AgentSettings(Duration.ofSeconds(30), Duration.ofMinutes(1), Duration.ofMillis(100));
}
