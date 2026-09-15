package fi.natroutter.fenpos.serial;

/** Writes a payload in bounded pieces so the port's write timeout bounds one piece, not the whole job. */
final class ChunkedWriter {

    /** Small enough that a slow serial link finishes one chunk well inside the minimum timeout. */
    static final int CHUNK_BYTES = 4096;

    interface Sink {
        /** @return bytes written, or a negative number when the device is gone */
        int write(byte[] buffer, int length, int offset);
    }

    private ChunkedWriter() {
    }

    /** @return the total written; less than {@code payload.length} means a chunk timed out */
    static int write(Sink sink, byte[] payload) {
        int offset = 0;
        while (offset < payload.length) {
            int length = Math.min(CHUNK_BYTES, payload.length - offset);
            int written = sink.write(payload, length, offset);
            if (written < 0) {
                return written;
            }
            offset += written;
            if (written != length) {
                return offset;
            }
        }
        return offset;
    }
}
