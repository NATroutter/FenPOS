package fi.natroutter.fenpos.link;

/**
 * Sends a frame to the server, if the link is up.
 * <p>
 * Narrower than {@link LinkClient} on purpose. What reports job state has no business starting,
 * stopping or inspecting the connection, and expressing that in the type means the reporting
 * path can be exercised without a socket.
 */
@FunctionalInterface
public interface FrameSender {

    /** A sender that drops everything, for an agent with no link yet. */
    FrameSender NONE = frame -> false;

    /**
     * @param frame the frame to send
     * @return whether it was handed to the socket
     */
    boolean send(Frames.AgentFrame frame);
}
