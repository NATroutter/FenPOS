package fi.natroutter.fenpos.link;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * The one thread that acts on what the server sends.
 *
 * <p><strong>Nothing blocking runs on the receive thread.</strong> That is the rule this class
 * exists to make statable. Handling a frame is not cheap work: {@code raw.write} writes to a
 * serial port with a timeout the server sets, up to two minutes, and {@code config.sync} opens
 * ports and rebuilds queues for as many as 256 devices. Doing any of it on the socket's own
 * thread means no further frame is read and no ping is answered, so the server's liveness check
 * fires and closes a link that was working, taking every printer behind this agent with it.
 *
 * <p>Single threaded, so frames are still acted on strictly in arrival order. The caller returns
 * this worker's future from {@code onText}, which is what {@code WebSocket.Listener} is built
 * for: a returned stage that has not completed tells the client not to deliver the next message
 * yet, without anything holding the thread that would have delivered it.
 */
final class FrameWorker {

    /** How long {@link #shutdown()} waits for a frame in flight before giving up on it. */
    private static final long SHUTDOWN_WAIT_SECONDS = 5;

    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "fenpos-agent-frames");
        thread.setDaemon(true);
        return thread;
    });

    /**
     * Hands one frame's handling to the worker.
     *
     * @param work what to do with the frame
     * @return a stage that completes when it has been done, for the listener to return
     */
    CompletableFuture<Void> submit(Runnable work) {
        return CompletableFuture.runAsync(work, executor);
    }

    /** Stops the worker, waiting briefly for a frame already in flight. */
    void shutdown() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(SHUTDOWN_WAIT_SECONDS, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            executor.shutdownNow();
        }
    }
}
