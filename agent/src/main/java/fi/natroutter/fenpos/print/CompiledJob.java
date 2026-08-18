package fi.natroutter.fenpos.print;

/**
 * A print request that has been fully validated, encoded and rendered.
 * <p>
 * Producing this before a job is queued is what makes the queue's contract simple: a job
 * that reaches it can only fail for hardware reasons, never because of its content.
 *
 * @param payload the complete ESC/POS byte stream to write to the device
 * @param lines   text lines after wrapping, reported in the job record
 */
public record CompiledJob(byte[] payload, int lines) {

    public CompiledJob {
        if (payload == null) {
            throw new IllegalArgumentException("payload must not be null");
        }
        if (lines < 0) {
            throw new IllegalArgumentException("lines must not be negative, got " + lines);
        }
    }

    /** Returns the payload size in bytes. */
    public int bytes() {
        return payload.length;
    }
}
