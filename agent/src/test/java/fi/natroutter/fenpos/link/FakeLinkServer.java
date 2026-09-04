package fi.natroutter.fenpos.link;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A WebSocket server, just enough of one to test {@link LinkClient} against.
 *
 * <p>It exists because the JDK ships a WebSocket client and no server, which is why
 * {@code LinkClientTest} could only ever test failing to connect. Everything interesting about
 * this agent's link happens after the handshake: whether a ping is still answered while a frame
 * is being handled, what an oversized frame does, whether a partial message accumulates under
 * the cap, and what close code 4003 clears.
 *
 * <p>Deliberately minimal. No extensions, no compression, no fragmentation on send, no masking
 * on send, which is what the specification requires of a server. Client frames are masked and
 * are unmasked here. Text, ping, pong and close are the only opcodes handled, which is the whole
 * of what this agent uses.
 */
public final class FakeLinkServer implements AutoCloseable {

    /** The constant every WebSocket handshake concatenates before hashing. See RFC 6455. */
    private static final String HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private static final int OPCODE_TEXT = 0x1;
    private static final int OPCODE_CLOSE = 0x8;
    private static final int OPCODE_PING = 0x9;
    private static final int OPCODE_PONG = 0xA;

    private final ServerSocket listener;
    private final Thread acceptor;
    private final List<String> received = new CopyOnWriteArrayList<>();
    private final LinkedBlockingQueue<String> frames = new LinkedBlockingQueue<>();
    private final LinkedBlockingQueue<Object> pongs = new LinkedBlockingQueue<>();
    private final AtomicBoolean open = new AtomicBoolean();

    private volatile Socket client;
    private volatile OutputStream out;

    public FakeLinkServer() throws IOException {
        this.listener = new ServerSocket(0, 1, InetAddress.getLoopbackAddress());
        this.acceptor = new Thread(this::accept, "fake-link-server");
        this.acceptor.setDaemon(true);
        this.acceptor.start();
    }

    /** The address an agent should be pointed at, which {@code LinkClient} appends its path to. */
    public URI uri() {
        return URI.create("http://127.0.0.1:" + listener.getLocalPort());
    }

    /** Whether a client has completed the handshake and not yet gone away. */
    public boolean isOpen() {
        return open.get();
    }

    /** Every text frame the client has sent, in order. */
    public List<String> received() {
        return List.copyOf(received);
    }

    /** Waits for the next text frame from the client, or returns null if none arrives in time. */
    public String awaitFrame(Duration timeout) throws InterruptedException {
        return frames.poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
    }

    /** Waits for a pong, which is what proves the client is still reading its socket. */
    public boolean awaitPong(Duration timeout) throws InterruptedException {
        return pongs.poll(timeout.toMillis(), TimeUnit.MILLISECONDS) != null;
    }

    /** Sends one text frame. */
    public void send(String text) throws IOException {
        write(OPCODE_TEXT, text.getBytes(StandardCharsets.UTF_8));
    }

    /** Sends a ping, which a conforming client answers without involving its listener. */
    public void sendPing() throws IOException {
        write(OPCODE_PING, new byte[0]);
    }

    /** Sends a close frame carrying a code, such as 4003 for an unpair. */
    public void close(int code, String reason) throws IOException {
        byte[] text = reason.getBytes(StandardCharsets.UTF_8);
        byte[] payload = new byte[2 + text.length];
        payload[0] = (byte) (code >> 8);
        payload[1] = (byte) code;
        System.arraycopy(text, 0, payload, 2, text.length);
        write(OPCODE_CLOSE, payload);
    }

    @Override
    public void close() {
        open.set(false);
        acceptor.interrupt();
        closeQuietly(client);
        closeQuietly(listener);
    }

    // ---------------------------------------------------------------------

    private void accept() {
        try {
            Socket socket = listener.accept();
            client = socket;
            out = socket.getOutputStream();
            handshake(socket.getInputStream(), out);
            open.set(true);
            read(socket.getInputStream());
        } catch (IOException e) {
            // The listener being closed is how this thread is meant to end.
            open.set(false);
        }
    }

    private static void handshake(InputStream in, OutputStream out) throws IOException {
        StringBuilder request = new StringBuilder();
        int previous = -1;
        for (int value = in.read(); value >= 0; value = in.read()) {
            request.append((char) value);
            if (previous == '\n' && value == '\r') {
                in.read();
                break;
            }
            previous = value;
        }

        String key = null;
        for (String line : request.toString().split("\r\n")) {
            if (line.toLowerCase().startsWith("sec-websocket-key:")) {
                key = line.substring(line.indexOf(':') + 1).trim();
            }
        }
        if (key == null) {
            throw new IOException("no Sec-WebSocket-Key in: " + request);
        }

        byte[] digest;
        try {
            digest = MessageDigest.getInstance("SHA-1")
                    .digest((key + HANDSHAKE_GUID).getBytes(StandardCharsets.US_ASCII));
        } catch (Exception e) {
            throw new IOException("SHA-1 is unavailable", e);
        }

        out.write(("HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: " + Base64.getEncoder().encodeToString(digest) + "\r\n"
                + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    private void read(InputStream in) throws IOException {
        while (true) {
            int first = in.read();
            if (first < 0) {
                open.set(false);
                return;
            }
            int opcode = first & 0x0F;
            int second = in.read();
            boolean masked = (second & 0x80) != 0;
            long length = second & 0x7F;
            if (length == 126) {
                length = (in.read() << 8) | in.read();
            } else if (length == 127) {
                length = 0;
                for (int index = 0; index < 8; index++) {
                    length = (length << 8) | in.read();
                }
            }
            byte[] mask = new byte[4];
            if (masked) {
                in.readNBytes(mask, 0, 4);
            }
            byte[] payload = in.readNBytes((int) length);
            if (masked) {
                for (int index = 0; index < payload.length; index++) {
                    payload[index] ^= mask[index % 4];
                }
            }

            switch (opcode) {
                case OPCODE_TEXT -> {
                    String text = new String(payload, StandardCharsets.UTF_8);
                    received.add(text);
                    frames.add(text);
                }
                case OPCODE_PONG -> pongs.add(new Object());
                case OPCODE_PING -> write(OPCODE_PONG, payload);
                case OPCODE_CLOSE -> {
                    open.set(false);
                    return;
                }
                default -> {
                    // Nothing else is used by this agent.
                }
            }
        }
    }

    private synchronized void write(int opcode, byte[] payload) throws IOException {
        OutputStream stream = out;
        if (stream == null) {
            throw new IOException("no client is connected");
        }
        stream.write(0x80 | opcode);
        if (payload.length < 126) {
            stream.write(payload.length);
        } else if (payload.length < 65_536) {
            stream.write(126);
            stream.write(payload.length >> 8);
            stream.write(payload.length & 0xFF);
        } else {
            stream.write(127);
            for (int shift = 56; shift >= 0; shift -= 8) {
                stream.write((int) ((long) payload.length >> shift) & 0xFF);
            }
        }
        stream.write(payload);
        stream.flush();
    }

    private static void closeQuietly(java.io.Closeable closeable) {
        if (closeable == null) {
            return;
        }
        try {
            closeable.close();
        } catch (IOException e) {
            // Closing is best effort in a test harness.
        }
    }
}
