package fi.natroutter.fenpos.serial;

import fi.natroutter.fenpos.enums.ConnectionStatus;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * A {@link PrinterPort} that records what it was asked to write.
 * <p>
 * Lets queue behaviour — ordering, capacity, pausing, failure handling — be asserted
 * exactly, on any machine, with no serial hardware attached.
 */
public class FakePrinterPort implements PrinterPort {

    private final List<byte[]> writes = Collections.synchronizedList(new ArrayList<>());
    private final CountDownLatch writesExpected;

    private volatile ConnectionStatus status = ConnectionStatus.CONNECTED;
    private volatile boolean failWrites;

    /**
     * @param expectedWrites how many writes a test intends to wait for
     */
    public FakePrinterPort(int expectedWrites) {
        this.writesExpected = new CountDownLatch(expectedWrites);
    }

    @Override
    public String deviceName() {
        return "fake";
    }

    @Override
    public ConnectionStatus status() {
        return status;
    }

    @Override
    public void write(byte[] payload) throws PrinterWriteException {
        if (failWrites) {
            writesExpected.countDown();
            throw new PrinterWriteException("fake failure");
        }
        writes.add(payload.clone());
        writesExpected.countDown();
    }

    /** Blocks until the expected number of writes has happened, or the timeout elapses. */
    public boolean awaitWrites(long timeoutMillis) throws InterruptedException {
        return writesExpected.await(timeoutMillis, TimeUnit.MILLISECONDS);
    }

    /** Returns a snapshot of everything written, in order. */
    public List<byte[]> writes() {
        synchronized (writes) {
            return List.copyOf(writes);
        }
    }

    /** Returns how many writes have happened. */
    public int writeCount() {
        return writes.size();
    }

    /** Makes every subsequent write fail, simulating an unresponsive printer. */
    public void failWrites() {
        this.failWrites = true;
    }

    /** Sets the reported connection state. */
    public void setStatus(ConnectionStatus status) {
        this.status = status;
    }
}
