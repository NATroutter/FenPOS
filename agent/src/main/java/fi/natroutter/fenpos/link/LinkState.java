package fi.natroutter.fenpos.link;

/**
 * What the link is doing, as reported by the {@code link} console command.
 * <p>
 * Observed state, never persisted. A socket cannot outlive the process that owns it, so a
 * stored "connected" would be wrong from the moment the agent restarts.
 */
public enum LinkState {

    /** No credential, so there is nothing to connect to. */
    UNPAIRED("not paired"),

    /** Paired, but the link has not been started. */
    IDLE("idle"),

    /** Dialling, or waiting out the backoff before the next attempt. */
    CONNECTING("connecting"),

    /** Connected and past the handshake; the server has sent its welcome. */
    CONNECTED("connected"),

    /** Shut down deliberately; no further attempts will be made. */
    STOPPED("stopped");

    private final String label;

    LinkState(String label) {
        this.label = label;
    }

    /** Returns the wording used in console output. */
    public String label() {
        return label;
    }
}
