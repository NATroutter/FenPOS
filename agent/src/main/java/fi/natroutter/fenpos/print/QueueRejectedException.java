package fi.natroutter.fenpos.print;

/**
 * Thrown when a compiled job cannot be accepted for printing.
 * <p>
 * Every reason here is temporary and about the device rather than the request, which is why
 * they all map to {@code 503}: the same request may well succeed a moment later.
 */
public class QueueRejectedException extends Exception {

    /** Why a job was refused. */
    public enum Reason {

        /** The port is not open, so nothing would print. */
        DEVICE_UNAVAILABLE("device_unavailable"),

        /** The device already has as many jobs pending as it is allowed. */
        QUEUE_FULL("queue_full"),

        /** An operator has stopped this device from printing. */
        DEVICE_PAUSED("device_paused");

        private final String apiCode;

        Reason(String apiCode) {
            this.apiCode = apiCode;
        }

        /** Returns the stable code for the response's {@code error} field. */
        public String apiCode() {
            return apiCode;
        }
    }

    private final Reason reason;

    /**
     * @param reason  why the job was refused
     * @param message human-readable explanation
     */
    public QueueRejectedException(Reason reason, String message) {
        super(message);
        this.reason = reason;
    }

    /** Returns why the job was refused. */
    public Reason reason() {
        return reason;
    }

    /** Returns the stable code for the response's {@code error} field. */
    public String apiCode() {
        return reason.apiCode();
    }
}
